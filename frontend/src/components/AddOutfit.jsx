import { useState } from "react";
import { addUser } from "../api";

function AddOutfit() {
  const [name, setName] = useState("");
  const [image, setImage] = useState("");

  const handleSubmit = async (e) => {
    e.preventDefault();

    await addUser({ name, image });

    alert("Outfit added!");
    setName("");
    setImage("");
  };

  return (
    <form onSubmit={handleSubmit}>
      <h2>Add Outfit</h2>

      <input
        placeholder="Name"
        value={name}
        onChange={(e) => setName(e.target.value)}
      />

      <input
        placeholder="Image key (bucket / overshirt / trousers)"
        value={image}
        onChange={(e) => setImage(e.target.value)}
      />

      <button type="submit">Add</button>
    </form>
  );
}

export default AddOutfit;