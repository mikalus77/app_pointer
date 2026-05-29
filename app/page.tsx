"use client";

import { useState } from "react";
import type { FormEvent } from "react";
import { useRouter } from "next/navigation";

const CONNECTED_USERNAME_STORAGE_KEY = "app_pointer_connected_username";
const CONNECTED_USERNAME_CHANGED_EVENT = "app_pointer_connected_username_changed";
const USERNAME_MAX_LENGTH = 20;

type AuthTab = "connexion" | "inscription";

export default function Home() {
  const router = useRouter();

  const [activeTab, setActiveTab] = useState<AuthTab>("connexion");

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showLoginPassword, setShowLoginPassword] = useState(false);
  const [erreurConnexion, setErreurConnexion] = useState("");
  const [showForgotPasswordForm, setShowForgotPasswordForm] = useState(false);
  const [forgotPassword, setForgotPassword] = useState("");
  const [forgotPasswordConfirm, setForgotPasswordConfirm] = useState("");
  const [showForgotPassword, setShowForgotPassword] = useState(false);
  const [showForgotPasswordConfirm, setShowForgotPasswordConfirm] = useState(false);
  const [erreurForgotPassword, setErreurForgotPassword] = useState("");
  const [forgotPasswordSuccess, setForgotPasswordSuccess] = useState("");

  const [nom, setNom] = useState("");
  const [prenom, setPrenom] = useState("");
  const [registerUsername, setRegisterUsername] = useState("");
  const [registerPassword, setRegisterPassword] = useState("");
  const [registerPasswordConfirm, setRegisterPasswordConfirm] = useState("");
  const [showRegisterPassword, setShowRegisterPassword] = useState(false);
  const [showRegisterPasswordConfirm, setShowRegisterPasswordConfirm] = useState(false);
  const [email, setEmail] = useState("");
  const [telephone, setTelephone] = useState("");
  const [adresse, setAdresse] = useState("");
  const [erreurInscription, setErreurInscription] = useState("");
  const [inscriptionSuccess, setInscriptionSuccess] = useState("");
  const normalizeErrorMessage = (message: string) => {
    const trimmed = message.trim();
    if (!trimmed) return "Une erreur est survenue !";
    const withoutEndingPunctuation = trimmed.replace(/[.!]+$/g, "");
    return `${withoutEndingPunctuation} !`;
  };

  const handleConnexion = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setErreurConnexion("");

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
      | { username?: string; role?: string; error?: string }
      | null;

    if (!response.ok || !responseData?.username) {
      setErreurConnexion(
        normalizeErrorMessage(responseData?.error ?? "Nom d'utilisateur ou mot de passe incorrect")
      );
      return;
    }

    window.localStorage.setItem(
      CONNECTED_USERNAME_STORAGE_KEY,
      responseData.username ?? username
    );
    window.dispatchEvent(new Event(CONNECTED_USERNAME_CHANGED_EVENT));
    const roleCode = String(responseData.role ?? "").trim().toUpperCase();
    if (roleCode === "RESPONSABLE_INTERVENTION") {
      router.push("/utilisateurs");
      return;
    }
    router.push("/accueil");
  };

  const handleInscription = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setErreurInscription("");
    setInscriptionSuccess("");

    if (!nom.trim() || !prenom.trim() || !registerUsername.trim() || !registerPassword || !email.trim()) {
      setErreurInscription("Veuillez remplir les champs obligatoires !");
      return;
    }

    if (registerUsername.trim().length > USERNAME_MAX_LENGTH) {
      setErreurInscription(
        `Le nom d'utilisateur doit contenir au maximum ${USERNAME_MAX_LENGTH} caractères !`
      );
      return;
    }

    if (registerPassword !== registerPasswordConfirm) {
      setErreurInscription("Les mots de passe ne correspondent pas !");
      return;
    }

    const response = await fetch("/api/auth/register", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        nom,
        prenom,
        username: registerUsername,
        password: registerPassword,
        email,
        telephone,
        adresse,
      }),
    });

    const responseData = (await response.json().catch(() => null)) as
      | { success?: boolean; error?: string }
      | null;

    if (!response.ok || !responseData?.success) {
      setErreurInscription(
        normalizeErrorMessage(responseData?.error ?? "Impossible d'enregistrer l'inscription")
      );
      return;
    }

    setInscriptionSuccess("Inscription enregistrée. Votre compte est en attente de validation.");
    setNom("");
    setPrenom("");
    setRegisterUsername("");
    setRegisterPassword("");
    setRegisterPasswordConfirm("");
    setEmail("");
    setTelephone("");
    setAdresse("");
  };

  const handleForgotPassword = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setErreurForgotPassword("");
    setForgotPasswordSuccess("");

    if (!username.trim()) {
      setErreurForgotPassword("Veuillez saisir le nom d'utilisateur !");
      return;
    }

    if (!forgotPassword || !forgotPasswordConfirm) {
      setErreurForgotPassword("Veuillez saisir et confirmer le mot de passe !");
      return;
    }

    if (forgotPassword !== forgotPasswordConfirm) {
      setErreurForgotPassword("Les mots de passe ne correspondent pas !");
      return;
    }

    const response = await fetch("/api/auth/forgot-password", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        username,
        newPassword: forgotPassword,
      }),
    });

    const responseData = (await response.json().catch(() => null)) as
      | { success?: boolean; error?: string }
      | null;

    if (!response.ok || !responseData?.success) {
      setErreurForgotPassword(
        normalizeErrorMessage(responseData?.error ?? "Impossible de modifier le mot de passe")
      );
      return;
    }

    setForgotPasswordSuccess("Mot de passe mis à jour avec succès.");
    setForgotPassword("");
    setForgotPasswordConfirm("");
    setShowForgotPassword(false);
    setShowForgotPasswordConfirm(false);
  };

  const tabStyle = (tab: AuthTab) => ({
    flex: 1,
    padding: "8px 0 10px",
    textAlign: "center" as const,
    color: activeTab === tab ? "#2e4a66" : "#6b7a89",
    fontWeight: activeTab === tab ? 700 : 500,
    letterSpacing: "0.02em",
    borderBottom: activeTab === tab ? "2px solid #2e4a66" : "2px solid #d7dfe7",
    cursor: "pointer",
    userSelect: "none" as const,
  });

  const inputStyle = {
    width: "100%",
    padding: "12px",
    borderRadius: "8px",
    border: "1px solid #ccc",
    boxSizing: "border-box" as const,
    overflowX: "auto" as const,
    whiteSpace: "nowrap" as const,
    textOverflow: "ellipsis",
  };
  const passwordInputStyle = { ...inputStyle, paddingRight: "44px" };
  const passwordFieldWrapStyle = { position: "relative" as const, width: "100%" };
  const passwordToggleStyle = {
    position: "absolute" as const,
    right: "10px",
    top: "50%",
    transform: "translateY(-50%)",
    border: "none",
    background: "transparent",
    cursor: "pointer",
    fontSize: "16px",
    lineHeight: 1,
    padding: 0,
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
      <div
        style={{
          width: "380px",
          padding: "32px",
          backgroundColor: "white",
          borderRadius: "12px",
          boxShadow: "0 8px 24px rgba(0,0,0,0.1)",
          display: "flex",
          flexDirection: "column",
          gap: "16px",
        }}
      >
        <div style={{ display: "flex", gap: "12px" }} role="tablist" aria-label="Authentification">
          <div
            role="tab"
            aria-selected={activeTab === "connexion"}
            tabIndex={0}
            onClick={() => setActiveTab("connexion")}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                setActiveTab("connexion");
              }
            }}
            style={tabStyle("connexion")}
          >
            Connexion
          </div>
          <div
            role="tab"
            aria-selected={activeTab === "inscription"}
            tabIndex={0}
            onClick={() => setActiveTab("inscription")}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                setActiveTab("inscription");
              }
            }}
            style={tabStyle("inscription")}
          >
            Inscription
          </div>
        </div>

        {activeTab === "connexion" ? (
          <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
            {!showForgotPasswordForm ? (
              <form
                onSubmit={handleConnexion}
                style={{ display: "flex", flexDirection: "column", gap: "16px", marginTop: "16px" }}
              >
                <input
                  type="text"
                  placeholder="Nom d'utilisateur"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  required
                  style={inputStyle}
                />
                <div style={passwordFieldWrapStyle}>
                  <input
                    type={showLoginPassword ? "text" : "password"}
                    placeholder="Mot de passe"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                    style={passwordInputStyle}
                  />
                  <button
                    type="button"
                    aria-label="Voir le mot de passe"
                    onClick={() => setShowLoginPassword((prev) => !prev)}
                    style={passwordToggleStyle}
                  >
                    {showLoginPassword ? "🙈" : "👁️"}
                  </button>
                </div>

                <button
                  type="button"
                  onClick={() => {
                    setShowForgotPasswordForm(true);
                    setErreurConnexion("");
                    setErreurForgotPassword("");
                    setForgotPasswordSuccess("");
                  }}
                  style={{
                    alignSelf: "flex-start",
                    border: "none",
                    background: "transparent",
                    color: "#2e4a66",
                    cursor: "pointer",
                    padding: 0,
                    textDecoration: "underline",
                    fontSize: "14px",
                  }}
                >
                  Mot de passe oublié ?
                </button>

                {erreurConnexion ? <p style={{ color: "red", margin: 0 }}>{erreurConnexion}</p> : null}

                <button
                  type="submit"
                  style={{
                    marginTop: "11px",
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
            ) : (
              <form
                onSubmit={handleForgotPassword}
                style={{ display: "flex", flexDirection: "column", gap: "12px", marginTop: "22px" }}
              >
                <input
                  type="text"
                  placeholder="Nom d'utilisateur"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  required
                  style={inputStyle}
                />
                <div style={passwordFieldWrapStyle}>
                  <input
                    type={showForgotPassword ? "text" : "password"}
                    placeholder="Nouveau mot de passe"
                    value={forgotPassword}
                    onChange={(e) => setForgotPassword(e.target.value)}
                    required
                    style={passwordInputStyle}
                  />
                  <button
                    type="button"
                    aria-label="Voir le mot de passe"
                    onClick={() => setShowForgotPassword((prev) => !prev)}
                    style={passwordToggleStyle}
                  >
                    {showForgotPassword ? "🙈" : "👁️"}
                  </button>
                </div>
                <div style={passwordFieldWrapStyle}>
                  <input
                    type={showForgotPasswordConfirm ? "text" : "password"}
                    placeholder="Confirmer le nouveau mot de passe"
                    value={forgotPasswordConfirm}
                    onChange={(e) => setForgotPasswordConfirm(e.target.value)}
                    required
                    style={passwordInputStyle}
                  />
                  <button
                    type="button"
                    aria-label="Voir le mot de passe"
                    onClick={() => setShowForgotPasswordConfirm((prev) => !prev)}
                    style={passwordToggleStyle}
                  >
                    {showForgotPasswordConfirm ? "🙈" : "👁️"}
                  </button>
                </div>

                {erreurForgotPassword ? <p style={{ color: "red", margin: 0 }}>{erreurForgotPassword}</p> : null}
                {forgotPasswordSuccess ? <p style={{ color: "#2a8a58", margin: 0 }}>{forgotPasswordSuccess}</p> : null}

                <button
                  type="submit"
                  style={{
                    marginTop: "11px",
                    padding: "10px",
                    borderRadius: "8px",
                    border: "none",
                    backgroundColor: "#2e4a66",
                    color: "white",
                    cursor: "pointer",
                    fontWeight: "600",
                  }}
                >
                  Valider le nouveau mot de passe
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setShowForgotPasswordForm(false);
                    setErreurForgotPassword("");
                    setForgotPasswordSuccess("");
                    setForgotPassword("");
                    setForgotPasswordConfirm("");
                  }}
                  style={{
                    marginTop: "-3px",
                    padding: "10px",
                    borderRadius: "8px",
                    border: "1px solid #2e4a66",
                    backgroundColor: "white",
                    color: "#2e4a66",
                    cursor: "pointer",
                    fontWeight: "600",
                  }}
                >
                  Retour à la connexion
                </button>
              </form>
            )}
          </div>
        ) : (
          <form
            onSubmit={handleInscription}
            style={{ display: "flex", flexDirection: "column", gap: "12px", marginTop: "16px" }}
          >
            <input
              type="text"
              placeholder="Prénom *"
              value={prenom}
              onChange={(e) => setPrenom(e.target.value)}
              required
              style={inputStyle}
            />
            <input
              type="text"
              placeholder="Nom *"
              value={nom}
              onChange={(e) => setNom(e.target.value)}
              required
              style={inputStyle}
            />
            <input
              type="text"
              placeholder={`Nom d'utilisateur * (${USERNAME_MAX_LENGTH} caractères maximum)`}
              value={registerUsername}
              onChange={(e) => setRegisterUsername(e.target.value)}
              required
              maxLength={USERNAME_MAX_LENGTH}
              style={inputStyle}
            />
                <div style={passwordFieldWrapStyle}>
                  <input
                    type={showRegisterPassword ? "text" : "password"}
                    placeholder="Mot de passe *"
                    value={registerPassword}
                    onChange={(e) => setRegisterPassword(e.target.value)}
                    required
                    style={passwordInputStyle}
                  />
                  <button
                    type="button"
                    aria-label="Voir le mot de passe"
                    onClick={() => setShowRegisterPassword((prev) => !prev)}
                    style={passwordToggleStyle}
                  >
                    {showRegisterPassword ? "🙈" : "👁️"}
                  </button>
                </div>
                <div style={passwordFieldWrapStyle}>
                  <input
                    type={showRegisterPasswordConfirm ? "text" : "password"}
                    placeholder="Confirmer le mot de passe *"
                    value={registerPasswordConfirm}
                    onChange={(e) => setRegisterPasswordConfirm(e.target.value)}
                    required
                    style={passwordInputStyle}
                  />
                  <button
                    type="button"
                    aria-label="Voir le mot de passe"
                    onClick={() => setShowRegisterPasswordConfirm((prev) => !prev)}
                    style={passwordToggleStyle}
                  >
                    {showRegisterPasswordConfirm ? "🙈" : "👁️"}
                  </button>
                </div>
            <input
              type="email"
              placeholder="Email *"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              style={inputStyle}
            />
            <input
              type="tel"
              placeholder="Téléphone"
              value={telephone}
              onChange={(e) => setTelephone(e.target.value)}
              style={inputStyle}
            />
            <input
              type="text"
              placeholder="Adresse"
              value={adresse}
              onChange={(e) => setAdresse(e.target.value)}
              style={inputStyle}
            />

            {erreurInscription ? <p style={{ color: "red", margin: 0 }}>{erreurInscription}</p> : null}
            {inscriptionSuccess ? (
              <p style={{ color: "#2a8a58", margin: 0 }}>{inscriptionSuccess}</p>
            ) : null}

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
              {"S'inscrire"}
            </button>
          </form>
        )}
      </div>
    </main>
  );
}
