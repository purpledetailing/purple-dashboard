"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import { useRouter } from "next/navigation";

type PendingSignup = {
  business_name?: string;
  contact_name?: string;
};

export default function LoginPage() {
  const router = useRouter();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function ensureBusinessRow() {
    // Must have a session user for RLS to allow insert/select
    const { data: userData, error: userErr } = await supabase.auth.getUser();
    if (userErr) throw userErr;

    const user = userData?.user;
    if (!user) throw new Error("No user session found. Please log in again.");

    // Check if business row exists for this user
    const { data: existing, error: fetchErr } = await supabase
      .from("businesses")
      .select("id")
      .eq("owner_user_id", user.id)
      .maybeSingle();

    if (fetchErr) throw fetchErr;

    if (existing?.id) return existing.id;

    // Create it using pending signup info (stored during signup)
    let pending: PendingSignup | null = null;
    try {
      const raw = localStorage.getItem("pv_pending_signup");
      pending = raw ? JSON.parse(raw) : null;
    } catch {
      pending = null;
    }

    const business_name = pending?.business_name?.trim() || "New Business";
    const contact_name = pending?.contact_name?.trim() || "";

    const { data: inserted, error: insErr } = await supabase
      .from("businesses")
      .insert({
        owner_user_id: user.id,
        business_name,
        contact_name,
      })
      .select("id")
      .single();

    if (insErr) throw insErr;

    // Clear pending once we successfully created the business
    localStorage.removeItem("pv_pending_signup");

    return inserted.id;
  }

  // ✅ If already logged in, ensure business row, then redirect
  useEffect(() => {
    (async () => {
      setErr(null);
      const { data, error } = await supabase.auth.getSession();

      if (error) return;
      if (!data.session) return;

      setLoading(true);
      try {
        await ensureBusinessRow();
        router.replace("/new-job");
      } catch (e: any) {
        setErr(e?.message ?? "Login session found, but failed preparing account.");
      } finally {
        setLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router]);

  async function onLogin(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    setLoading(true);

    const { error } = await supabase.auth.signInWithPassword({
      email: email.trim(),
      password,
    });

    if (error) {
      setLoading(false);
      setErr(error.message);
      return;
    }

    try {
      await ensureBusinessRow();
      router.replace("/new-job");
    } catch (e: any) {
      setErr(e?.message ?? "Signed in, but failed creating business row.");
    } finally {
      setLoading(false);
    }
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
