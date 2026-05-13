"use client";

import { useState } from "react";
import type { FormEvent } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "../lib/supabase";

const CONNECTED_USERNAME_STORAGE_KEY = "app_pointer_connected_username";

export default function Home() {
  const router = useRouter();

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [erreur, setErreur] = useState("");

  const handleConnexion = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setErreur("");

    const { data, error } = await supabase
      .from("utilisateur")
      .select("*")
      .eq("username_utilisateur", username)
      .eq("password_utilisateur", password)
      .eq("actif", true)
      .single();

    if (error || !data) {
      setErreur("Nom d'utilisateur ou mot de passe incorrect.");
      return;
    }

    window.localStorage.setItem(
      CONNECTED_USERNAME_STORAGE_KEY,
      data.username_utilisateur ?? username
    );
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
