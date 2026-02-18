"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import { useRouter } from "next/navigation";

export default function LoginPage() {
  const router = useRouter();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // ✅ If already logged in, skip login page
  useEffect(() => {
    (async () => {
      const { data, error } = await supabase.auth.getSession();
      if (!error && data.session) {
        router.replace("/new-job");
      }
    })();
  }, [router]);

  async function onLogin(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    setLoading(true);

    const { error } = await supabase.auth.signInWithPassword({
      email: email.trim(),
      password,
    });

    setLoading(false);

    if (error) {
      setErr(error.message);
      return;
    }

    // ✅ send them to field tool start
    router.replace("/new-job");
  }

  return (
    <div style={{ maxWidth: 420, margin: "48px auto", padding: 16 }}>
      <h1 style={{ fontSize: 28, fontWeight: 800 }}>Business Login</h1>
      <p style={{ opacity: 0.8, marginTop: 8 }}>Sign in to PurpleVin.</p>

      <form onSubmit={onLogin} style={{ marginTop: 16, display: "grid", gap: 10 }}>
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
          autoComplete="current-password"
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
            cursor: loading ? "not-allowed" : "pointer",
            opacity: loading ? 0.7 : 1,
          }}
        >
          {loading ? "Signing in..." : "Sign In"}
        </button>
      </form>

      <div style={{ marginTop: 14, fontSize: 14, opacity: 0.85 }}>
        Need an account? <a href="/signup">Create a business account</a>
      </div>
    </div>
  );
} 
