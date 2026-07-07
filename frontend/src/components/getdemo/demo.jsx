import React, { useEffect, useRef, useState, useCallback } from "react";
import { Pose } from "@mediapipe/pose";
import { Camera } from "@mediapipe/camera_utils";

// ─── small helpers ───────────────────────────────────────────────────────────
function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

// Exponential smoothing per-value (position, size, angle) instead of one
// shared value, so the shirt tracks the body without jittering.
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

function shoulderAngle(left, right) {
  let angle = Math.atan2(right.y - left.y, right.x - left.x);
  if (angle > Math.PI / 2) angle -= Math.PI;
  if (angle < -Math.PI / 2) angle += Math.PI;
  return angle;
}

// ─── Draw the garment warped onto a 4-point quad ────────────────────────────
// Splitting the quad into two triangles and solving the affine transform for
// each lets the shirt tilt/shear with the shoulders instead of being a
// straight, rigidly-rotated rectangle.
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

// Subtle shading so the flat png doesn't look pasted on: highlight near the
// collar, soft shadow toward the hem.
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

function quadPath(ctx, corners) {
  const [tl, tr, br, bl] = corners;
  ctx.beginPath();
  ctx.moveTo(tl.x, tl.y);
  ctx.lineTo(tr.x, tr.y);
  ctx.lineTo(br.x, br.y);
  ctx.lineTo(bl.x, bl.y);
  ctx.closePath();
}

export default function VirtualTryOn() {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const clothRef = useRef(null);

  // Persistent offscreen canvases reused every frame (avoid re-allocating).
  const clothLayerRef = useRef(null); // rendered garment + shading + tint
  const maskLayerRef = useRef(null); // feathered alpha mask for soft edges
  if (!clothLayerRef.current) clothLayerRef.current = document.createElement("canvas");
  if (!maskLayerRef.current) maskLayerRef.current = document.createElement("canvas");

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
  const smoothNeckY = useSmoothRef(0.8);

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

      // Draw the mirrored (selfie-view) camera feed, then restore the
      // transform immediately. Everything after this uses plain, un-flipped
      // canvas coordinates — we mirror landmark X ourselves instead of
      // keeping the ctx flip active (rotating inside an active horizontal
      // flip spins the visual result the wrong way, which was the original
      // alignment bug).
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
      const mouthL = lm[9];
      const mouthR = lm[10];

      if (!ls || !rs || !lh || !rh || !mouthL || !mouthR) {
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
      const mouthY = ((mouthL.y + mouthR.y) / 2) * H;

      const shoulderCX = (lsX + rsX) / 2;
      const hipCX = (lhX + rhX) / 2;
      const torsoCX = (shoulderCX + hipCX) / 2;

      const shoulderCY = (lsY + rsY) / 2;
      const hipCY = (lhY + rhY) / 2;
      const rawShoulderWidth = Math.abs(lsX - rsX);

      // Close-up framing (as on a laptop webcam) often puts the hips
      // partly or fully off-screen. MediaPipe still returns a position for
      // them in that case, but with low confidence, and trusting it can
      // make the shirt's height unstable frame-to-frame. When hip
      // visibility is poor, fall back to a fixed torso-height-to-shoulder-
      // width ratio (a typical body proportion) instead of the shaky
      // hip-based measurement.
      const hipVis = (lh.visibility + rh.visibility) / 2;
      const hipBasedTorsoH = hipCY - shoulderCY;
      const fallbackTorsoH = rawShoulderWidth * 1.45;
      const rawTorsoH =
        hipVis > 0.5
          ? hipBasedTorsoH
          : hipVis > 0.15
          ? hipBasedTorsoH * (hipVis / 0.5) + fallbackTorsoH * (1 - hipVis / 0.5)
          : fallbackTorsoH;

      // ── Neck / jaw line ─────────────────────────────────────────────────
      // Pose landmarks don't include the jaw directly, so we approximate the
      // neck base as a point between the mouth and the shoulder line. This
      // is what the garment gets clipped against, so it can never render
      // up over the chin/face regardless of how big the size estimate is.
      const rawNeckY = mouthY + (shoulderCY - mouthY) * 0.5;
      const neckY = smoothNeckY(rawNeckY);

      // ── Adaptive sizing ──────────────────────────────────────────────────
      // A fixed 1.7x/1.45x ratio looked fine at a "standing back" distance
      // but became oversized up close (webcam close-ups make the shoulder
      // span a much bigger fraction of the frame). Damp the scale down as
      // the subject gets closer to the camera.
      const shoulderFrac = rawShoulderWidth / W;
      const proximityDamp = clamp(1 - (shoulderFrac - 0.2) * 1.1, 0.7, 1.05);

      // Slightly wider than the raw shoulder-to-shoulder span so the
      // garment's shoulder seams sit just past the body outline — enough
      // to cover the collar/fabric of whatever the person is actually
      // wearing underneath, without ballooning out into the oversized look
      // from before.
      const SCALE_W = 1.62 * proximityDamp;
      const SCALE_H = 1.3 * proximityDamp;

      const rawCW = rawShoulderWidth * SCALE_W;
      const rawCH = rawTorsoH * SCALE_H;

      // Anchor the collar to the neck line (not an arbitrary shoulder
      // offset): push the shirt's center down so its top edge sits a bit
      // ABOVE the neck line — the neck clip (applied later) trims that
      // excess away, leaving a clean collar edge right at the jaw no matter
      // how the size estimate above comes out.
      const rawCY = neckY + rawCH * 0.35;
      const rawCX = torsoCX;

      // Clamp the tilt to a realistic range. A momentary tracking glitch
      // (e.g. one shoulder landmark briefly drifting due to low
      // confidence) can otherwise produce an angle near ±90°, which turns
      // the quad's "width" axis nearly vertical and warps the garment into
      // a long diagonal sliver instead of a shirt shape.
      const MAX_TILT = 0.45; // ~26°, generous for someone facing a webcam
      const rawAngle = clamp(
        shoulderAngle({ x: lsX, y: lsY }, { x: rsX, y: rsY }),
        -MAX_TILT,
        MAX_TILT
      );

      // If the detected shoulder span is implausibly small relative to the
      // frame, the landmarks are unreliable this frame (occlusion, partial
      // view, etc.) — skip drawing rather than render garbage geometry.
      if (rawShoulderWidth < W * 0.08) return;

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
      // partially follows it (gravity keeps a real hem hanging straighter),
      // giving a subtle, more natural drape.
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
      if (!(img && img.complete && img.naturalWidth > 0)) return;

      // ── Sample ambient light from the video right where the collar sits ──
      // so the garment can be tinted toward the room's actual lighting
      // instead of keeping its own flat studio-photo color.
      let tintColor = null;
      try {
        const sx = Math.round(clamp(cx, 2, W - 2));
        const sy = Math.round(clamp(topEdgeY - 8, 2, H - 2));
        const px = ctx.getImageData(sx, sy, 1, 1).data;
        tintColor = `rgba(${px[0]}, ${px[1]}, ${px[2]}, 0.12)`;
      } catch (e) {
        tintColor = null; // canvas tainted (rare) — skip tinting for this frame
      }

      // ── Render the garment (shaded + tinted) onto an offscreen layer ─────
      const cloth = clothLayerRef.current;
      cloth.width = W;
      cloth.height = H;
      const cctx = cloth.getContext("2d");
      cctx.clearRect(0, 0, W, H);

      cctx.save();
      cctx.filter = "blur(1px)"; // softens the crisp studio-photo edge slightly
      drawWarpedCloth(cctx, img, corners);
      cctx.restore();

      drawLightingOverlay(cctx, corners, 0.14);

      if (tintColor) {
        cctx.save();
        cctx.globalCompositeOperation = "overlay";
        cctx.fillStyle = tintColor;
        quadPath(cctx, corners);
        cctx.fill();
        cctx.restore();
      }

      // ── Feather the garment's edges ───────────────────────────────────────
      // A hard-edged cutout is the biggest single tell that a shirt is
      // "pasted on". Build a blurred alpha mask of the same quad and use it
      // to fade the garment's own edges before compositing.
      const mask = maskLayerRef.current;
      mask.width = W;
      mask.height = H;
      const mctx = mask.getContext("2d");
      mctx.clearRect(0, 0, W, H);
      mctx.save();
      mctx.filter = "blur(7px)";
      mctx.fillStyle = "#fff";
      quadPath(mctx, corners);
      mctx.fill();
      mctx.restore();

      cctx.save();
      cctx.globalCompositeOperation = "destination-in";
      cctx.drawImage(mask, 0, 0);
      cctx.restore();

      // ── Composite onto the main canvas ────────────────────────────────────
      ctx.save();

      // Clip to a curved neckline so the shirt can never appear above the
      // jaw, whatever the size estimate does.
      const collarHalf = rawShoulderWidth * 0.22;
      const leftPtX = clamp(cx - collarHalf, 0, W);
      const rightPtX = clamp(cx + collarHalf, 0, W);
      const dip = ch * 0.04;
      ctx.beginPath();
      ctx.moveTo(0, neckY);
      ctx.lineTo(leftPtX, neckY);
      ctx.quadraticCurveTo(cx, neckY + dip, rightPtX, neckY);
      ctx.lineTo(W, neckY);
      ctx.lineTo(W, H);
      ctx.lineTo(0, H);
      ctx.closePath();
      ctx.clip();

      // A soft contact shadow, cast from the garment's own alpha silhouette,
      // grounds it against the neck/shoulders instead of floating on top.
      ctx.save();
      ctx.shadowColor = "rgba(0,0,0,0.32)";
      ctx.shadowBlur = 9;
      ctx.shadowOffsetY = 4;
      ctx.globalAlpha = 0.95;
      ctx.drawImage(cloth, 0, 0);
      ctx.restore();

      ctx.restore(); // remove neckline clip
    }

    return () => {
      camera.stop();
      pose.close();
    };
  }, [smoothA, smoothCX, smoothCY, smoothH, smoothW, smoothNeckY]);

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
      <img
        ref={clothRef}
        src={clothes[type][index]}
        alt="cloth"
        style={{ display: "none" }}
        crossOrigin="anonymous"
      />
    </div>
  );
}