"use client";

import { useState } from "react";
import { supabase } from "@/lib/supabaseClient";

export default function SignupPage() {
  const [businessName, setBusinessName] = useState("");
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSignup(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    setMsg(null);
    setLoading(true);

    const cleanBusiness = businessName.trim();
    const cleanName = fullName.trim();
    const cleanEmail = email.trim();

    if (!cleanBusiness) {
      setErr("Business name is required.");
      setLoading(false);
      return;
    }

    if (!cleanEmail) {
      setErr("Email is required.");
      setLoading(false);
      return;
    }

    if (!password || password.length < 6) {
      setErr("Password must be at least 6 characters.");
      setLoading(false);
      return;
    }

    try {
      // Save locally for later use
      localStorage.setItem(
        "pv_pending_signup",
        JSON.stringify({
          business_name: cleanBusiness,
          contact_name: cleanName,
          email: cleanEmail,
          created_at: new Date().toISOString(),
        })
      );

      // Create Supabase user
      const { error } = await supabase.auth.signUp({
        email: cleanEmail,
        password,
        options: {
          emailRedirectTo: "https://intel.purplevin.com/login",
          data: {
            full_name: cleanName,
            business_name: cleanBusiness,
          },
        },
      });

      if (error) throw error;

      // 🔥 CUSTOM MESSAGE (THIS IS YOUR NEW FLOW)
      setMsg(
        "Your account request has been received. Our team will review your business and contact you within 24 hours from signup@purplevin.com."
      );

      // Optional: clear form
      setBusinessName("");
      setFullName("");
      setEmail("");
      setPassword("");

    } catch (e: any) {
      console.error(e);
      setErr(e?.message || "Signup failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{ maxWidth: 520, margin: "48px auto", padding: 16 }}>
      <h1 style={{ fontSize: 34, fontWeight: 900 }}>
        Create Business Account
      </h1>

      <p style={{ opacity: 0.8, marginTop: 8 }}>
        Start capturing cosmetic history with PurpleVin.
      </p>

      <form
        onSubmit={onSignup}
        style={{ display: "grid", gap: 10, marginTop: 18 }}
      >
        <input
          value={businessName}
          onChange={(e) => setBusinessName(e.target.value)}
          placeholder="Business name"
          style={{ padding: 12, borderRadius: 10, border: "1px solid #ddd" }}
        />

        <input
          value={fullName}
          onChange={(e) => setFullName(e.target.value)}
          placeholder="Your name"
          style={{ padding: 12, borderRadius: 10, border: "1px solid #ddd" }}
        />

        <input
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="Email"
          autoComplete="email"
          style={{ padding: 12, borderRadius: 10, border: "1px solid #ddd" }}
        />

        <input
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Password"
          type="password"
          autoComplete="new-password"
          style={{ padding: 12, borderRadius: 10, border: "1px solid #ddd" }}
        />

        {err && (
          <div style={{ color: "crimson", fontSize: 14 }}>{err}</div>
        )}

        {msg && (
          <div style={{ color: "seagreen", fontSize: 14 }}>{msg}</div>
        )}

        <button
          disabled={loading}
          style={{
            padding: 12,
            borderRadius: 999,
            fontWeight: 800,
            border: "none",
            cursor: loading ? "not-allowed" : "pointer",
            opacity: loading ? 0.7 : 1,
          }}
        >
          {loading ? "Creating..." : "Request Access"}
        </button>
      </form>

      <div style={{ marginTop: 14, fontSize: 14, opacity: 0.85 }}>
        Already have one? <a href="/login">Log in</a>
      </div>
    </div>
  );
}
