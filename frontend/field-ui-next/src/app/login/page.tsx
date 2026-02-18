"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import { useRouter } from "next/navigation";

type PendingSignup = {
  business_name?: string;
  contact_name?: string;
  email?: string;
  created_at?: string;
};

export default function LoginPage() {
  const router = useRouter();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // If already logged in, ensure business then go to /new-job
  useEffect(() => {
    (async () => {
      const { data } = await supabase.auth.getSession();
      if (data.session) {
        const ok = await ensureBusiness();
        if (ok) router.replace("/new-job");
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function ensureBusiness(): Promise<boolean> {
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
      setErr(linkErr.message);
      return false;
    }

    if (link?.business_id) {
      // already linked to a business
      return true;
    }

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
      setErr("No business name found to create the account. Please sign up again.");
      return false;
    }

    // 4) call RPC to create business + link user
    const { data: newBizId, error: rpcErr } = await supabase.rpc(
      "create_business_for_user",
      { business_name: bizName }
    );

    if (rpcErr) {
      setErr(rpcErr.message);
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
