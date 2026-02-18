"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function SignupPage() {
  const router = useRouter();
  const [businessName, setBusinessName] = useState("");
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSignup(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    setLoading(true);

    const res = await fetch("/api/auth/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password, businessName, fullName }),
    });

    const data = await res.json();
    setLoading(false);

    if (!res.ok) {
      setErr(data?.error || "Signup failed");
      return;
    }

    router.push("/login");
  }

  return (
    <div style={{ maxWidth: 460, margin: "48px auto", padding: 16 }}>
      <h1 style={{ fontSize: 28, fontWeight: 800 }}>Create Business Account</h1>
      <p style={{ opacity: 0.8, marginTop: 8 }}>
        Start capturing cosmetic history with PurpleVin.
      </p>

      <form onSubmit={onSignup} style={{ marginTop: 16, display: "grid", gap: 10 }}>
        <input
          value={businessName}
          onChange={(e) => setBusinessName(e.target.value)}
          placeholder="Business name (e.g., Jared’s Detailing)"
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
            border: "none",
            fontWeight: 700,
            cursor: "pointer",
          }}
        >
          {loading ? "Creating..." : "Create Account"}
        </button>
      </form>

      <div style={{ marginTop: 14, fontSize: 14, opacity: 0.85 }}>
        Already have one? <a href="/login">Log in</a>
      </div>
    </div>
  );
} 
