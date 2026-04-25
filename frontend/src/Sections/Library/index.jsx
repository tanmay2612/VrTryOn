import React, { useEffect, useRef } from "react";
import "./index.css";

import bucket1Image from "../../assets/bucket1.jpg";
import overshirt1Image from "../../assets/overshirt1.jpg";
import trousers1Image from "../../assets/trousers1.jpeg";

const imageMap = {
  bucket: bucket1Image,
  overshirt: overshirt1Image,
  trousers: trousers1Image,
};

function Library({ data }) {
  const libraryRef = useRef(null);

  useEffect(() => {
    const observer = new IntersectionObserver((entries) => {
      const [entry] = entries;
      if (entry.isIntersecting) {
        entry.target.classList.add("in-view");
      }
    });

    if (libraryRef.current) observer.observe(libraryRef.current);

    return () => observer.disconnect();
  }, []);

  // Loading & empty states
  if (!data) return <p style={{ textAlign: "center" }}>Loading...</p>;
  if (data.length === 0)
    return <p style={{ textAlign: "center" }}>No outfits available</p>;

  return (
    <div className="library-container" ref={libraryRef}>
      <div className="heading">
        <h1>Our Library</h1>
      </div>

      <div className="container">
        {data.map((item, index) => (
          <div
            key={index}
            className={`card image-hover-${(index % 3) + 1}`}
          >
            <img
              src={
                imageMap[item.image] ||
                "https://via.placeholder.com/400"
              }
              alt={item.name}
            />

            {/* 🔥 Overlay text (no bottom box) */}
            <div className="overlay">
              <h3>{item.name}</h3>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export default Library;