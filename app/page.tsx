"use client";

import { useState } from "react";
import type { FormEvent } from "react";
import { useRouter } from "next/navigation";

const CONNECTED_USERNAME_STORAGE_KEY = "app_pointer_connected_username";
const CONNECTED_USERNAME_CHANGED_EVENT = "app_pointer_connected_username_changed";

export default function Home() {
  const router = useRouter();

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [erreur, setErreur] = useState("");

  const handleConnexion = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setErreur("");

    const response = await fetch("/api/auth/login", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        username,
        password,
      }),
    });

    const responseData = (await response.json().catch(() => null)) as
      | { username?: string; error?: string }
      | null;

    if (!response.ok || !responseData?.username) {
      setErreur(responseData?.error ?? "Nom d'utilisateur ou mot de passe incorrect.");
      return;
    }

    window.localStorage.setItem(
      CONNECTED_USERNAME_STORAGE_KEY,
      responseData.username ?? username
    );
    window.dispatchEvent(new Event(CONNECTED_USERNAME_CHANGED_EVENT));
    router.push("/accueil");
  };

  return (
    <main
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: "#f5f7fa",
      }}
    >
      <form
        onSubmit={handleConnexion}
        style={{
          width: "340px",
          padding: "32px",
          backgroundColor: "white",
          borderRadius: "12px",
          boxShadow: "0 8px 24px rgba(0,0,0,0.1)",
          display: "flex",
          flexDirection: "column",
          gap: "16px",
        }}
      >
        <h1 style={{ textAlign: "center", margin: 0 }}>Connexion</h1>

        <input
          type="text"
          placeholder="Nom d'utilisateur"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          required
          style={{ padding: "12px", borderRadius: "8px", border: "1px solid #ccc" }}
        />

        <input
          type="password"
          placeholder="Mot de passe"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          style={{ padding: "12px", borderRadius: "8px", border: "1px solid #ccc" }}
        />

        {erreur && <p style={{ color: "red", margin: 0 }}>{erreur}</p>}

        <button
          type="submit"
          style={{
            padding: "12px",
            borderRadius: "8px",
            border: "none",
            backgroundColor: "#2e4a66",
            color: "white",
            cursor: "pointer",
            fontWeight: "600",
          }}
        >
          Se connecter
        </button>
      </form>
    </main>
  );
}
