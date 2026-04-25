const BASE_URL = "https://vrtryon-backend.onrender.com";

export async function getUsers() {
  const res = await fetch(`${BASE_URL}/api/users`);
  if (!res.ok) throw new Error("Failed to fetch users");
  return res.json();
}

export async function addUser(payload) {
  const res = await fetch(`${BASE_URL}/api/users`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error("Failed to add user");
  return res.json();
}