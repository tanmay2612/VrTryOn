import React, { useEffect, useRef, useState, useCallback } from "react";
import { Pose } from "@mediapipe/pose";
import { Camera } from "@mediapipe/camera_utils";

// ─── Smoothing helper ────────────────────────────────────────────────────────
// Exponential smoothing per-value (position, size, angle) instead of one
// shared value. Smoothing each independently keeps the shirt from jittering
// while still tracking body movement responsively.
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
  return smooth;
}

// ─── Angle between shoulders, normalized to (-90°, 90°] ─────────────────────
function shoulderAngle(left, right) {
  let angle = Math.atan2(right.y - left.y, right.x - left.x);
  if (angle > Math.PI / 2) angle -= Math.PI;
  if (angle < -Math.PI / 2) angle += Math.PI;
  return angle;
}

// ─── Draw the garment warped onto a 4-point quad ────────────────────────────
// Splitting the quad into two triangles and solving the affine transform for
// each lets the shirt tilt/shear with the shoulders instead of just being a
// straight, rotated rectangle — this is what makes it "drape" realistically.
function drawWarpedCloth(ctx, img, corners) {
  if (!img || !img.complete || img.naturalWidth === 0) return;

  const [tl, tr, br, bl] = corners;
  const sw = img.naturalWidth;
  const sh = img.naturalHeight;

  const triangles = [
    { dst: [tl, tr, br], src: [{ x: 0, y: 0 }, { x: sw, y: 0 }, { x: sw, y: sh }] },
    { dst: [tl, br, bl], src: [{ x: 0, y: 0 }, { x: sw, y: sh }, { x: 0, y: sh }] },
  ];

  for (const { dst, src } of triangles) {
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(dst[0].x, dst[0].y);
    ctx.lineTo(dst[1].x, dst[1].y);
    ctx.lineTo(dst[2].x, dst[2].y);
    ctx.closePath();
    ctx.clip();

    const [s0, s1, s2] = src;
    const [d0, d1, d2] = dst;

    const sx1 = s1.x - s0.x, sy1 = s1.y - s0.y;
    const sx2 = s2.x - s0.x, sy2 = s2.y - s0.y;
    const dx1 = d1.x - d0.x, dy1 = d1.y - d0.y;
    const dx2 = d2.x - d0.x, dy2 = d2.y - d0.y;

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

// ─── Subtle shading so the flat png doesn't look pasted on ──────────────────
function drawLightingOverlay(ctx, corners, alpha = 0.15) {
  const [tl, tr, br, bl] = corners;
  const midTopX = (tl.x + tr.x) / 2;
  const midTopY = (tl.y + tr.y) / 2;
  const midBotX = (bl.x + br.x) / 2;
  const midBotY = (bl.y + br.y) / 2;

  const grad = ctx.createLinearGradient(midTopX, midTopY, midBotX, midBotY);
  grad.addColorStop(0, `rgba(255,255,255,${alpha * 0.6})`);
  grad.addColorStop(0.4, "rgba(0,0,0,0)");
  grad.addColorStop(1, `rgba(0,0,0,${alpha})`);

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

export default function VirtualTryOn() {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const clothRef = useRef(null);

  const [type, setType] = useState("shirt");
  const [index, setIndex] = useState(0);
  const [confidence, setConfidence] = useState(0);

  const clothes = {
    shirt: ["/clothes/shirt1.png", "/clothes/shirt.png"],
    tshirt: ["/clothes/tshirt1.png", "/clothes/tshirt.png"],
  };

  // Smooth each parameter independently
  const smoothCX = useSmoothRef(0.8);
  const smoothCY = useSmoothRef(0.8);
  const smoothW = useSmoothRef(0.75);
  const smoothH = useSmoothRef(0.75);
  const smoothA = useSmoothRef(0.85);

  useEffect(() => {
    const pose = new Pose({
      locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/pose/${file}`,
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

      // Draw the mirrored (selfie-view) camera feed, then IMMEDIATELY restore
      // the transform. Everything drawn after this point uses plain,
      // un-flipped canvas coordinates.
      //
      // The previous version kept the ctx.scale(-1, 1) flip active while also
      // rotating the shirt with ctx.rotate(angle). A rotation performed inside
      // a horizontally-mirrored context spins in the OPPOSITE visual
      // direction, so whenever the person tilted their shoulders the shirt
      // tilted the wrong way relative to their mirrored body — that was the
      // core "alignment" bug. Restoring right after drawing the video avoids
      // that trap entirely: we mirror the landmark X coordinates ourselves
      // (mirroredX = (1 - x) * W) and do all subsequent math/drawing in a
      // normal, non-flipped coordinate space.
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

      const vis = (ls.visibility + rs.visibility + lh.visibility + rh.visibility) / 4;
      setConfidence(Math.round(vis * 100));

      // Mirror X to match the mirrored video we just drew; Y is unaffected.
      const lsX = (1 - ls.x) * W;
      const rsX = (1 - rs.x) * W;
      const lsY = ls.y * H;
      const rsY = rs.y * H;
      const lhX = (1 - lh.x) * W;
      const rhX = (1 - rh.x) * W;
      const lhY = lh.y * H;
      const rhY = rh.y * H;

      const shoulderCX = (lsX + rsX) / 2;
      const hipCX = (lhX + rhX) / 2;
      const torsoCX = (shoulderCX + hipCX) / 2;

      const shoulderCY = (lsY + rsY) / 2;
      const hipCY = (lhY + rhY) / 2;
      const rawTorsoH = hipCY - shoulderCY;
      const rawShoulderWidth = Math.abs(lsX - rsX);

      // Tuned sizing: the old 2.1x shoulder-width ratio made the shirt look
      // absurdly wide (draping way past the arms). 1.7x/1.45x reads as a
      // properly-fitted garment while still covering the shoulders/arms.
      const SCALE_W = 1.7;
      const SCALE_H = 1.45;

      const rawCW = rawShoulderWidth * SCALE_W;
      const rawCH = rawTorsoH * SCALE_H;

      // Collar sits slightly above the shoulder line rather than centered on it.
      const rawCY = shoulderCY + rawCH * (0.5 - 0.1);
      const rawCX = torsoCX;
      const rawAngle = shoulderAngle({ x: lsX, y: lsY }, { x: rsX, y: rsY });

      const cx = smoothCX(rawCX);
      const cy = smoothCY(rawCY);
      const cw = smoothW(rawCW);
      const ch = smoothH(rawCH);
      const angle = smoothA(rawAngle);

      const halfW = cw / 2;
      const halfH = ch / 2;
      const cosA = Math.cos(angle);
      const sinA = Math.sin(angle);

      // Top edge follows the shoulder tilt fully; the bottom edge only
      // partially follows it (a real shirt hangs straighter at the hem due
      // to gravity), which gives a subtle, more natural drape/perspective.
      const topTiltX = halfW * cosA;
      const topTiltY = halfW * sinA;
      const botTiltFactor = 0.3;
      const botTiltX = halfW * cosA * botTiltFactor;
      const botTiltY = halfW * sinA * botTiltFactor;

      const topEdgeY = cy - halfH;
      const botEdgeY = cy + halfH;

      const corners = [
        { x: cx - topTiltX, y: topEdgeY - topTiltY }, // top-left
        { x: cx + topTiltX, y: topEdgeY + topTiltY }, // top-right
        { x: cx + botTiltX, y: botEdgeY + botTiltY }, // bottom-right
        { x: cx - botTiltX, y: botEdgeY - botTiltY }, // bottom-left
      ];

      const img = clothRef.current;
      if (img && img.complete && img.naturalWidth > 0) {
        ctx.save();
        ctx.globalAlpha = 0.93; // slight transparency so the body shows through at the edges
        drawWarpedCloth(ctx, img, corners);
        drawLightingOverlay(ctx, corners, 0.14);
        ctx.restore();
      }
    }

    return () => {
      camera.stop();
      pose.close();
    };
  }, [smoothA, smoothCX, smoothCY, smoothH, smoothW]);

  useEffect(() => {
    if (clothRef.current) {
      clothRef.current.src = clothes[type][index];
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [type, index]);

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
        padding: "20px",
      }}
    >
      <h1 style={{ margin: "0 0 4px" }}>StyleSnap 👕</h1>
      <p style={{ opacity: 0.7, margin: "0 0 12px" }}>Try outfits in real-time</p>

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
            confidence > 70 ? "#22c55e" : confidence > 40 ? "#eab308" : "#ef4444"
          }`,
          fontSize: "13px",
        }}
      >
        Pose confidence: {confidence}%
      </div>

      {/* Camera + overlay */}
      <div
        style={{
          position: "relative",
          width: "700px",
          maxWidth: "100%",
          height: "500px",
          borderRadius: "16px",
          overflow: "hidden",
          boxShadow: "0 25px 60px rgba(0,0,0,0.6)",
        }}
      >
        {/* Raw camera feed is only used as an input source for MediaPipe —
            the canvas below draws the (correctly mirrored) visible frame,
            so the <video> itself stays invisible to avoid a double image. */}
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          style={{ position: "absolute", opacity: 0, width: "100%", height: "100%" }}
        />
        <canvas
          ref={canvasRef}
          style={{ position: "absolute", top: 0, left: 0, width: "100%", height: "100%" }}
        />
      </div>

      {/* Category buttons */}
      <div style={{ marginTop: "20px", display: "flex", gap: "10px" }}>
        <button onClick={() => { setType("shirt"); setIndex(0); }}>Shirts</button>
        <button onClick={() => { setType("tshirt"); setIndex(0); }}>T-Shirts</button>
      </div>

      {/* Thumbnails */}
      <div
        style={{
          marginTop: "15px",
          display: "flex",
          gap: "10px",
          overflowX: "auto",
          padding: "10px",
        }}
      >
        {clothes[type].map((img, i) => (
          <img
            key={i}
            src={img}
            alt="thumb"
            onClick={() => setIndex(i)}
            style={{
              width: "70px",
              height: "70px",
              objectFit: "cover",
              borderRadius: "10px",
              cursor: "pointer",
              border: index === i ? "3px solid #6366f1" : "2px solid transparent",
              transition: "0.2s",
            }}
          />
        ))}
      </div>

      {/* Hidden cloth image used as the drawing source */}
      <img ref={clothRef} src={clothes[type][index]} alt="cloth" style={{ display: "none" }} crossOrigin="anonymous" />
    </div>
  );
}