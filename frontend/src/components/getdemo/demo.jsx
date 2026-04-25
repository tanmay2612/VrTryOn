import React, { useEffect, useRef, useState } from "react";
import { Pose } from "@mediapipe/pose";
import { Camera } from "@mediapipe/camera_utils";

export default function VirtualTryOn() {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const clothRef = useRef(null);

  const [type, setType] = useState("shirt");
  const [index, setIndex] = useState(0);

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
      const ctx = canvas.getContext("2d");

      canvas.width = videoRef.current.videoWidth;
      canvas.height = videoRef.current.videoHeight;

      ctx.clearRect(0, 0, canvas.width, canvas.height);

      ctx.save();
      ctx.translate(canvas.width, 0);
      ctx.scale(-1, 1);

      ctx.drawImage(results.image, 0, 0, canvas.width, canvas.height);

      if (!results.poseLandmarks) {
        ctx.restore();
        return;
      }

      const leftShoulder = results.poseLandmarks[11];
      const rightShoulder = results.poseLandmarks[12];
      const leftHip = results.poseLandmarks[23];
      const rightHip = results.poseLandmarks[24];

      if (!leftShoulder || !rightShoulder || !leftHip || !rightHip) {
        ctx.restore();
        return;
      }

      const w = canvas.width;
      const h = canvas.height;

      const leftX = leftShoulder.x * w;
      const rightX = rightShoulder.x * w;

      const leftY = leftShoulder.y * h;
      const rightY = rightShoulder.y * h;

      const leftHipY = leftHip.y * h;
      const rightHipY = rightHip.y * h;

      const centerX = (leftX + rightX) / 2;
      const shoulderY = (leftY + rightY) / 2;
      const hipY = (leftHipY + rightHipY) / 2;

      const torsoHeight = hipY - shoulderY;
      const shoulderWidth = Math.abs(rightX - leftX);

      const clothWidth = shoulderWidth * 2.1;
      const clothHeight = torsoHeight * 1.5;
      const centerY = shoulderY + torsoHeight * 0.40;

      let angle = Math.atan2(rightY - leftY, rightX - leftX);
      if (angle > Math.PI / 2 || angle < -Math.PI / 2) {
        angle += Math.PI;
      }

      const smooth = 0.7;

      if (!window.prevX) {
        window.prevX = centerX;
        window.prevY = centerY;
      } else {
        window.prevX = window.prevX * smooth + centerX * (1 - smooth);
        window.prevY = window.prevY * smooth + centerY * (1 - smooth);
      }

      const img = clothRef.current;

      // safe drawing condition
      if (!img || !img.complete) {
        ctx.restore();
        return;
      }

      ctx.save();
      ctx.translate(window.prevX, window.prevY);
      ctx.rotate(angle);

      ctx.drawImage(
        img,
        -clothWidth / 2,
        -clothHeight / 2,
        clothWidth,
        clothHeight
      );

      ctx.restore();
      ctx.restore();
    }
  }, []);

  // ensure image updates properly
  useEffect(() => {
    if (clothRef.current) {
      clothRef.current.src = clothes[type][index];
    }
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
      }}
    >
      <h1>StyleSnap 👕</h1>
      <p style={{ opacity: 0.7 }}>Try outfits in real-time</p>

      {/* Camera */}
      <div
        style={{
          position: "relative",
          width: "700px",
          height: "500px",
          borderRadius: "16px",
          overflow: "hidden",
        }}
      >
        <video ref={videoRef} autoPlay playsInline style={{ width: "100%" }} />
        <canvas
          ref={canvasRef}
          style={{ position: "absolute", top: 0, left: 0, width: "100%" }}
        />
      </div>

      {/* Category buttons */}
      <div style={{ marginTop: "20px", display: "flex", gap: "10px" }}>
        <button onClick={() => { setType("shirt"); setIndex(0); }}>
          Shirts
        </button>
        <button onClick={() => { setType("tshirt"); setIndex(0); }}>
          T-Shirts
        </button>
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
              border:
                index === i
                  ? "3px solid #6366f1"
                  : "2px solid transparent",
              transition: "0.2s",
            }}
          />
        ))}
      </div>

      {/* Hidden cloth image */}
      <img
        ref={clothRef}
        src={clothes[type][index]}
        alt="cloth"
        style={{ display: "none" }}
      />
    </div>
  );
}