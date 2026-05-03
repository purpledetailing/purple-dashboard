"use client";

import { useState } from "react";
import { supabase } from "@/lib/supabaseClient";

export default function SignupPage() {
  const [businessName, setBusinessName] = useState("");
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [submitted, setSubmitted] = useState(false); // 🔥 NEW

  async function onSignup(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    setLoading(true);

    const cleanBusiness = businessName.trim();
    const cleanName = fullName.trim();
    const cleanEmail = email.trim();

    if (!cleanBusiness) {
      setLoading(false);
      setErr("Business name is required.");
      return;
    }
    if (!cleanEmail) {
      setLoading(false);
      setErr("Email is required.");
      return;
    }
    if (!password || password.length < 6) {
      setLoading(false);
      setErr("Password must be at least 6 characters.");
      return;
    }

    try {
      // Store lead data locally (you can later push this to DB if needed)
      localStorage.setItem(
        "pv_pending_signup",
        JSON.stringify({
          business_name: cleanBusiness,
          contact_name: cleanName,
          email: cleanEmail,
          created_at: new Date().toISOString(),
        })
      );

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

      // 🔥 IMPORTANT: DO NOT redirect
      setSubmitted(true);

    } catch (e: any) {
      console.error("SIGNUP FAILED:", e);
      setErr(e?.message ?? "Signup failed");
    } finally {
      setLoading(false);
    }
  }

  // 🔥 PENDING STATE SCREEN
  if (submitted) {
    return (
      <div style={{ maxWidth: 520, margin: "80px auto", padding: 20, textAlign: "center" }}>
        <h1 style={{ fontSize: 34, fontWeight: 900 }}>Request Received</h1>

        <p style={{ marginTop: 16, fontSize: 16, opacity: 0.85 }}>
          Your account has been submitted for review.
        </p>

        <p style={{ marginTop: 10, fontSize: 15, opacity: 0.75 }}>
          A PurpleVin specialist will contact you within 24 hours to approve access.
        </p>

        <p style={{ marginTop: 20, fontSize: 13, opacity: 0.6 }}>
          Please check your email to confirm your address.
        </p>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 520, margin: "48px auto", padding: 16 }}>
      <h1 style={{ fontSize: 34, fontWeight: 900 }}>Request Access</h1>

      <p style={{ opacity: 0.8, marginTop: 8 }}>
        Submit your business for review. We’ll contact you within 24 hours to approve access.
      </p>

      <form onSubmit={onSignup} style={{ display: "grid", gap: 10, marginTop: 18 }}>
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

        {err && <div style={{ color: "crimson", fontSize: 14 }}>{err}</div>}

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
          {loading ? "Submitting..." : "Request Access"}
        </button>
      </form>

      <div style={{ marginTop: 14, fontSize: 14, opacity: 0.85 }}>
        Already have access? <a href="/login">Log in</a>
      </div>
    </div>
  );
} 
