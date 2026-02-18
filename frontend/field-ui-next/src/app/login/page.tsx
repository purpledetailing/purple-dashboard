"use client";

import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import { useRouter, useSearchParams } from "next/navigation";

type PendingSignup = {
  business_name?: string;
  contact_name?: string;
  email?: string;
  created_at?: string;
};

export default function LoginPage() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const nextPath = useMemo(() => {
    const n = searchParams.get("next");
    // safety: only allow internal paths
    if (n && n.startsWith("/")) return n;
    return "/new-job";
  }, [searchParams]);

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [checking, setChecking] = useState(true);

  // ✅ On load: if already logged in, ensure business then redirect
  useEffect(() => {
    let cancelled = false;

    (async () => {
      setChecking(true);
      setErr(null);

      const { data, error } = await supabase.auth.getSession();
      if (cancelled) return;

      if (error) {
        setErr(error.message);
        setChecking(false);
        return;
      }

      if (!data.session) {
        setChecking(false);
        return; // not logged in, show form
      }

      const ok = await ensureBusiness();
      if (cancelled) return;

      setChecking(false);
      if (ok) router.replace(nextPath);
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nextPath]);

  async function ensureBusiness(): Promise<boolean> {
    setErr(null);

    // 1) get current user
    const { data: userRes, error: userErr } = await supabase.auth.getUser();
    if (userErr || !userRes.user) {
      setErr(userErr?.message ?? "Not logged in.");
      return false;
    }
    const user = userRes.user;

    // 2) do we already have a business link?
    const { data: link, error: linkErr } = await supabase
      .from("business_users")
      .select("business_id")
      .eq("user_id", user.id)
      .limit(1)
      .maybeSingle();

    if (linkErr) {
      setErr(`business_users lookup failed: ${linkErr.message}`);
      return false;
    }

    if (link?.business_id) return true;

    // 3) Need to create business now (first login after signup)
    let pending: PendingSignup | null = null;
    try {
      pending = JSON.parse(localStorage.getItem("pv_pending_signup") || "null");
    } catch {}

    const bizName =
      pending?.business_name?.trim() ||
      (user.user_metadata?.business_name as string | undefined)?.trim() ||
      "";

    if (!bizName) {
      setErr("No business name found. Please sign up again.");
      return false;
    }

    // 4) call RPC to create business + link user
    const { data: newBizId, error: rpcErr } = await supabase.rpc(
      "create_business_for_user",
      { business_name: bizName }
    );

    if (rpcErr) {
      setErr(`RPC create_business_for_user failed: ${rpcErr.message}`);
      return false;
    }

    // cleanup pending signup (we’re done)
    localStorage.removeItem("pv_pending_signup");

    return !!newBizId;
  }

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

    const ok = await ensureBusiness();

    setLoading(false);
    if (!ok) return;

    router.replace(nextPath);
  }

  // Optional: small UX while checking existing session
  if (checking) {
    return (
      <div style={{ maxWidth: 420, margin: "48px auto", padding: 16 }}>
        <h1 style={{ fontSize: 28, fontWeight: 800 }}>Business Login</h1>
        <p style={{ opacity: 0.8, marginTop: 8 }}>Checking session...</p>
      </div>
    );
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
