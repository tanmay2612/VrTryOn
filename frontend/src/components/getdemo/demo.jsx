import React, { useEffect, useRef, useState, useCallback } from "react";
import { Pose } from "@mediapipe/pose";
import { Camera } from "@mediapipe/camera_utils";

// ─── Smoothing helpers ──────────────────────────────────────────────────────
function useSmoothRef(factor = 0.75) {
  const ref = useRef(null);
  const smooth = useCallback(
    (next) => {
      if (ref.current == null) {
        ref.current = next;
      } else {
        ref.current = ref.current * factor + next * (1 - factor);
      }
      return ref.current;
    },
    [factor]
  );
  return [ref, smooth];
}

// ─── Draw a perspective-warped quad for the garment ──────────────────────────
//
// We define four corner points of the shirt (top-left, top-right,
// bottom-right, bottom-left) and warp the canvas context to map
// the image into that quad using a simple affine transform split
// into two triangles.  This gives a basic 3-D drape effect that
// responds to shoulder tilt.
//
// srcW / srcH = natural dimensions of the clothing image
// corners     = [TL, TR, BR, BL] as {x, y}
function drawWarpedCloth(ctx, img, corners) {
  if (!img || !img.complete || img.naturalWidth === 0) return;

  const [tl, tr, br, bl] = corners;
  const sw = img.naturalWidth;
  const sh = img.naturalHeight;

  // Draw two triangles that together cover the quad
  // Triangle 1: TL, TR, BR   →  maps to image (0,0), (sw,0), (sw,sh)
  // Triangle 2: TL, BR, BL   →  maps to image (0,0), (sw,sh), (0,sh)

  const triangles = [
    {
      dst: [tl, tr, br],
      src: [
        { x: 0, y: 0 },
        { x: sw, y: 0 },
        { x: sw, y: sh },
      ],
    },
    {
      dst: [tl, br, bl],
      src: [
        { x: 0, y: 0 },
        { x: sw, y: sh },
        { x: 0, y: sh },
      ],
    },
  ];

  for (const { dst, src } of triangles) {
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(dst[0].x, dst[0].y);
    ctx.lineTo(dst[1].x, dst[1].y);
    ctx.lineTo(dst[2].x, dst[2].y);
    ctx.closePath();
    ctx.clip();

    // Solve the affine 2-D transform that maps src triangle → dst triangle
    const [s0, s1, s2] = src;
    const [d0, d1, d2] = dst;

    // Build matrix that maps src → dst
    // [a, b, c]   [sx]   [dx]
    // [d, e, f] × [sy] = [dy]
    //             [ 1]
    const sx1 = s1.x - s0.x,
      sy1 = s1.y - s0.y;
    const sx2 = s2.x - s0.x,
      sy2 = s2.y - s0.y;
    const dx1 = d1.x - d0.x,
      dy1 = d1.y - d0.y;
    const dx2 = d2.x - d0.x,
      dy2 = d2.y - d0.y;

    const det = sx1 * sy2 - sx2 * sy1;
    if (Math.abs(det) < 1e-6) {
      ctx.restore();
      continue;
    }

    const a = (dx1 * sy2 - dx2 * sy1) / det;
    const b = (dx2 * sx1 - dx1 * sx2) / det;
    const c = d0.x - a * s0.x - b * s0.y;
    const d = (dy1 * sy2 - dy2 * sy1) / det;
    const e = (dy2 * sx1 - dy1 * sx2) / det;
    const f = d0.y - d * s0.x - e * s0.y;

    ctx.transform(a, d, b, e, c, f);
    ctx.drawImage(img, 0, 0);
    ctx.restore();
  }
}

// ─── Lighting overlay — subtle gradient to simulate torso shadow ──────────
function drawLightingOverlay(ctx, corners, alpha = 0.18) {
  const [tl, tr, br, bl] = corners;

  const midTopX = (tl.x + tr.x) / 2;
  const midTopY = (tl.y + tr.y) / 2;
  const midBotX = (bl.x + br.x) / 2;
  const midBotY = (bl.y + br.y) / 2;

  const grad = ctx.createLinearGradient(midTopX, midTopY, midBotX, midBotY);
  grad.addColorStop(0, `rgba(255,255,255,${alpha * 0.6})`); // slight highlight at top
  grad.addColorStop(0.4, `rgba(0,0,0,0)`);
  grad.addColorStop(1, `rgba(0,0,0,${alpha})`); // shadow at bottom

  ctx.save();
  ctx.globalCompositeOperation = "multiply";
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.moveTo(tl.x, tl.y);
  ctx.lineTo(tr.x, tr.y);
  ctx.lineTo(br.x, br.y);
  ctx.lineTo(bl.x, bl.y);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

// ─── Compute shoulder angle between two points ───────────────────────────────
function shoulderAngle(left, right) {
  let angle = Math.atan2(right.y - left.y, right.x - left.x);
  if (angle > Math.PI / 2) angle -= Math.PI;
  if (angle < -Math.PI / 2) angle += Math.PI;
  return angle;
}

// ─── Main component ──────────────────────────────────────────────────────────
export default function VirtualTryOn() {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const clothRef = useRef(null);

  const [type, setType] = useState("shirt");
  const [index, setIndex] = useState(0);
  const [confidence, setConfidence] = useState(0);

  // Smooth position/size values independently so transitions feel fluid
  const [cxRef, smoothCX] = useSmoothRef(0.8);
  const [cyRef, smoothCY] = useSmoothRef(0.8);
  const [wRef, smoothW] = useSmoothRef(0.75);
  const [hRef, smoothH] = useSmoothRef(0.75);
  const [aRef, smoothA] = useSmoothRef(0.85);

  const clothes = {
    shirt: ["/clothes/shirt1.png", "/clothes/shirt.png"],
    tshirt: ["/clothes/tshirt1.png", "/clothes/tshirt.png"],
  };

  useEffect(() => {
    const pose = new Pose({
      locateFile: (file) =>
        `https://cdn.jsdelivr.net/npm/@mediapipe/pose/${file}`,
    });

    pose.setOptions({
      modelComplexity: 1,
      smoothLandmarks: true,
      enableSegmentation: false,
      minDetectionConfidence: 0.5,
      minTrackingConfidence: 0.5,
    });

    pose.onResults(onResults);

    const camera = new Camera(videoRef.current, {
      onFrame: async () => {
        await pose.send({ image: videoRef.current });
      },
      width: 640,
      height: 480,
    });

    camera.start();

    function onResults(results) {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext("2d");

      canvas.width = videoRef.current.videoWidth;
      canvas.height = videoRef.current.videoHeight;
      const W = canvas.width;
      const H = canvas.height;

      ctx.clearRect(0, 0, W, H);

      // Mirror the video feed
      ctx.save();
      ctx.translate(W, 0);
      ctx.scale(-1, 1);
      ctx.drawImage(results.image, 0, 0, W, H);
      ctx.restore();

      const lm = results.poseLandmarks;
      if (!lm) {
        setConfidence(0);
        return;
      }

      const ls = lm[11]; // left shoulder
      const rs = lm[12]; // right shoulder
      const lh = lm[23]; // left hip
      const rh = lm[24]; // right hip

      if (!ls || !rs || !lh || !rh) {
        setConfidence(0);
        return;
      }

      // Use visibility as a proxy for confidence
      const vis =
        (ls.visibility + rs.visibility + lh.visibility + rh.visibility) / 4;
      setConfidence(Math.round(vis * 100));

      // ── Raw measurements ─────────────────────────────────────────────────
      // MediaPipe gives normalized coords (0–1). X=0 is the LEFT of the raw
      // camera image (which is the person's RIGHT because front-cameras mirror).
      // We draw the canvas mirrored (selfie view), so to place the overlay in
      // the mirrored space we simply mirror X: mirroredX = (1 - landmark.x) * W
      const lsX = (1 - ls.x) * W;   // left shoulder  in mirrored canvas
      const rsX = (1 - rs.x) * W;   // right shoulder in mirrored canvas
      const lsY = ls.y * H;
      const rsY = rs.y * H;
      const lhX = (1 - lm[23].x) * W;
      const rhX = (1 - lm[24].x) * W;
      const lhY = lh.y * H;
      const rhY = rh.y * H;

      // Torso center X — average of all four anchor points for robustness
      const shoulderCX = (lsX + rsX) / 2;
      const hipCX      = (lhX + rhX) / 2;
      const torsoCX    = (shoulderCX + hipCX) / 2;

      const shoulderCY = (lsY + rsY) / 2;
      const hipCY      = (lhY + rhY) / 2;
      const rawTorsoH  = hipCY - shoulderCY;

      // Shoulder span measured in the mirrored space
      const rawShoulderWidth = Math.abs(lsX - rsX);

      // ── Sizing ────────────────────────────────────────────────────────────
      // Width:  shirt needs to be wider than the shoulder span to cover arms
      const SCALE_W = 1.7;
      // Height: shirt spans from collar (slightly above shoulders) to below hips
      const SCALE_H = 1.45;

      const rawCW = rawShoulderWidth * SCALE_W;
      const rawCH = rawTorsoH * SCALE_H;

      // ── Vertical center ───────────────────────────────────────────────────
      // The shirt image has collar near top, hem near bottom.
      // We want collar ≈ at shoulder level → center = shoulders + half shirt height
      // Nudge up slightly (×0.1) so collar sits AT the shoulder, not below it.
      const rawCY = shoulderCY + rawCH * (0.5 - 0.10);

      // ── Horizontal center ─────────────────────────────────────────────────
      // Use torso center rather than shoulder center alone (more stable)
      const rawCX = torsoCX;

      const rawAngle = shoulderAngle(
        { x: lsX, y: lsY },
        { x: rsX, y: rsY }
      );

      // ── Smooth values ─────────────────────────────────────────────────────
      const cx = smoothCX(rawCX);
      const cy = smoothCY(rawCY);
      const cw = smoothW(rawCW);
      const ch = smoothH(rawCH);
      const angle = smoothA(rawAngle);

      // ── Build the four corner points with shoulder tilt applied ───────────
      // We tilt the top edge to follow the shoulders, while the bottom edge
      // stays more horizontal (shirt hangs straight due to gravity).
      // This creates the perspective-like drape effect.
      const halfW = cw / 2;
      const halfH = ch / 2;

      const cosA = Math.cos(angle);
      const sinA = Math.sin(angle);

      // Top edge follows shoulder tilt fully
      const topTiltX = halfW * cosA;
      const topTiltY = halfW * sinA;

      // Bottom edge: only 30% of shoulder tilt (shirt hangs more vertically)
      const botTiltFactor = 0.3;
      const botTiltX = halfW * cosA * botTiltFactor;
      const botTiltY = halfW * sinA * botTiltFactor;

      // Vertical offsets (perpendicular to tilt for top, straight down for bottom)
      const topEdgeY = cy - halfH;
      const botEdgeY = cy + halfH;

      const corners = [
        { x: cx - topTiltX, y: topEdgeY - topTiltY }, // TL
        { x: cx + topTiltX, y: topEdgeY + topTiltY }, // TR
        { x: cx + botTiltX, y: botEdgeY + botTiltY }, // BR
        { x: cx - botTiltX, y: botEdgeY - botTiltY }, // BL
      ];

      // ── Draw garment ──────────────────────────────────────────────────────
      const img = clothRef.current;
      if (img && img.complete && img.naturalWidth > 0) {
        // Slight transparency so the body shows through at edges
        ctx.save();
        ctx.globalAlpha = 0.93;
        drawWarpedCloth(ctx, img, corners);
        ctx.restore();

        // Subtle lighting / shadow overlay to blend with the body
        drawLightingOverlay(ctx, corners, 0.14);
      }

      // ── Debug dots (comment out when happy with alignment) ────────────────
      if (window.__vrDebug) {
        const dots = [
          { x: lsX, y: lsY, c: "#00ff00", label: "LS" },
          { x: rsX, y: rsY, c: "#ff0000", label: "RS" },
          { x: lhX, y: lhY, c: "#00ffff", label: "LH" },
          { x: rhX, y: rhY, c: "#ff00ff", label: "RH" },
          { x: cx,  y: cy,  c: "#ffff00", label: "CTR" },
        ];
        dots.forEach(({ x, y, c, label }) => {
          ctx.beginPath();
          ctx.arc(x, y, 6, 0, Math.PI * 2);
          ctx.fillStyle = c;
          ctx.fill();
          ctx.fillStyle = "white";
          ctx.font = "bold 12px sans-serif";
          ctx.fillText(label, x + 8, y - 4);
        });
      }
    }
  }, []);

  // Update clothing image when selection changes
  useEffect(() => {
    if (clothRef.current) {
      clothRef.current.src = clothes[type][index];
    }
  }, [type, index]);

  const btnBase = {
    padding: "10px 22px",
    borderRadius: "8px",
    border: "none",
    cursor: "pointer",
    fontWeight: 600,
    fontSize: "15px",
    transition: "all 0.2s",
  };

  return (
    <div
      style={{
        minHeight: "100vh",
        background: "linear-gradient(135deg, #0f172a, #1e293b, #334155)",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        color: "white",
        fontFamily: "system-ui, sans-serif",
        padding: "20px",
      }}
    >
      <h1 style={{ margin: "0 0 4px", fontSize: "2rem" }}>StyleSnap 👕</h1>
      <p style={{ opacity: 0.65, margin: "0 0 16px" }}>
        Try outfits in real-time
      </p>

      {/* Confidence badge */}
      <div
        style={{
          marginBottom: "12px",
          padding: "4px 14px",
          borderRadius: "999px",
          background:
            confidence > 70
              ? "rgba(34,197,94,0.25)"
              : confidence > 40
              ? "rgba(234,179,8,0.25)"
              : "rgba(239,68,68,0.25)",
          border: `1px solid ${
            confidence > 70
              ? "#22c55e"
              : confidence > 40
              ? "#eab308"
              : "#ef4444"
          }`,
          fontSize: "13px",
        }}
      >
        Pose confidence: {confidence}%
      </div>

      {/* Camera view */}
      <div
        style={{
          position: "relative",
          width: "640px",
          height: "480px",
          borderRadius: "18px",
          overflow: "hidden",
          boxShadow: "0 25px 60px rgba(0,0,0,0.6)",
          border: "1px solid rgba(255,255,255,0.1)",
        }}
      >
        {/* Video is hidden — canvas shows both feed + overlay */}
        <video
          ref={videoRef}
          autoPlay
          playsInline
          style={{ position: "absolute", opacity: 0, width: "100%" }}
        />
        <canvas
          ref={canvasRef}
          style={{ width: "100%", height: "100%", display: "block" }}
        />
      </div>

      {/* Category selector */}
      <div style={{ marginTop: "20px", display: "flex", gap: "10px" }}>
        {Object.keys(clothes).map((cat) => (
          <button
            key={cat}
            onClick={() => {
              setType(cat);
              setIndex(0);
            }}
            style={{
              ...btnBase,
              background: type === cat ? "#6366f1" : "rgba(255,255,255,0.1)",
              color: "white",
              transform: type === cat ? "scale(1.05)" : "scale(1)",
            }}
          >
            {cat.charAt(0).toUpperCase() + cat.slice(1) + "s"}
          </button>
        ))}
      </div>

      {/* Thumbnails */}
      <div
        style={{
          marginTop: "16px",
          display: "flex",
          gap: "12px",
          padding: "10px",
        }}
      >
        {clothes[type].map((src, i) => (
          <img
            key={i}
            src={src}
            alt={`option ${i + 1}`}
            onClick={() => setIndex(i)}
            style={{
              width: "72px",
              height: "72px",
              objectFit: "cover",
              borderRadius: "12px",
              cursor: "pointer",
              border: index === i ? "3px solid #6366f1" : "2px solid rgba(255,255,255,0.2)",
              boxShadow: index === i ? "0 0 12px rgba(99,102,241,0.6)" : "none",
              transition: "all 0.2s",
              background: "rgba(255,255,255,0.05)",
            }}
          />
        ))}
      </div>

      {/* Tips */}
      <p style={{ opacity: 0.45, fontSize: "13px", marginTop: "12px" }}>
        Stand back 1–2 m · Good lighting · Face the camera straight on
      </p>

      {/* Debug toggle */}
      <button
        onClick={() => { window.__vrDebug = !window.__vrDebug; }}
        style={{
          marginTop: "8px",
          padding: "4px 12px",
          fontSize: "12px",
          background: "rgba(255,255,255,0.08)",
          border: "1px solid rgba(255,255,255,0.2)",
          borderRadius: "6px",
          color: "rgba(255,255,255,0.5)",
          cursor: "pointer",
        }}
      >
        Toggle landmark dots
      </button>

      {/* Hidden reference image for the cloth renderer */}
      <img
        ref={clothRef}
        src={clothes[type][index]}
        alt=""
        style={{ display: "none" }}
        crossOrigin="anonymous"
      />
    </div>
  );
}