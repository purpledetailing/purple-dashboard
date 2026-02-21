"use client";

import React, { useEffect, useMemo, useState } from "react";
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

  // ✅ Set your elephant asset path here
  // Put elephant-bg.png in: /public/img/elephant-bg.png
  const elephantUrl = useMemo(() => "/img/elephant-bg.png", []);

  // ✅ Control the look here:
  const ELEPHANT_SIZE_PX = 360; // bigger number = bigger elephants
  const ELEPHANT_OPACITY = 0.18; // 0.10–0.25 good range

  // ✅ On load: ONLY redirect if there is an active session
  useEffect(() => {
    let alive = true;

    (async () => {
      try {
        const { data, error } = await supabase.auth.getSession();
        if (!alive) return;

        if (error) {
          console.warn("getSession error:", error.message);
          return;
        }

        if (data.session) {
          const ok = await ensureBusiness();
          if (!alive) return;
          if (ok) router.replace("/new-job");
        }
      } catch (e: any) {
        console.warn("login boot error:", e?.message ?? e);
      }
    })();

    return () => {
      alive = false;
    };
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
    if (link?.business_id) return true;

    // 3) pull business name from localStorage OR user_metadata
    let pending: PendingSignup | null = null;
    if (typeof window !== "undefined") {
      try {
        pending = JSON.parse(localStorage.getItem("pv_pending_signup") || "null");
      } catch {}
    }

    const bizName =
      pending?.business_name?.trim() ||
      (user.user_metadata?.business_name as string | undefined)?.trim() ||
      "";

    if (!bizName) {
      setErr("No business name found. Please sign up again.");
      return false;
    }

    // 4) create business + link user via RPC (recommended for RLS)
    const { data: newBizId, error: rpcErr } = await supabase.rpc(
      "create_business_for_user",
      { business_name: bizName }
    );

    if (rpcErr) {
      setErr(rpcErr.message);
      return false;
    }

    if (typeof window !== "undefined") {
      localStorage.removeItem("pv_pending_signup");
    }

    return !!newBizId;
  }

  async function onLogin(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    setLoading(true);

    try {
      const { error } = await supabase.auth.signInWithPassword({
        email: email.trim(),
        password,
      });

      if (error) {
        setErr(error.message);
        return;
      }

      const ok = await ensureBusiness();
      if (!ok) return;

      router.replace("/new-job");
    } catch (e: any) {
      setErr(e?.message ?? "Login failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={styles.page}>
      {/* 🐘 Elephant layer */}
      <div
        aria-hidden
        style={{
          ...styles.elephants,
          backgroundImage: `url(${elephantUrl})`,
          backgroundSize: `${ELEPHANT_SIZE_PX}px ${ELEPHANT_SIZE_PX}px`,
          opacity: ELEPHANT_OPACITY,
        }}
      />

      {/* subtle dark vignette so card pops */}
      <div aria-hidden style={styles.vignette} />

      <div style={styles.card}>
        <h1 style={styles.h1}>Business Login</h1>
        <p style={styles.p}>Sign in to PurpleVin.</p>

        <form onSubmit={onLogin} style={styles.form}>
          <input
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="Email"
            autoComplete="email"
            style={styles.input}
          />
          <input
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Password"
            type="password"
            autoComplete="current-password"
            style={styles.input}
          />

          {err && <div style={styles.err}>{err}</div>}

          <button disabled={loading} style={{ ...styles.button, opacity: loading ? 0.7 : 1 }}>
            {loading ? "Signing in..." : "Sign In"}
          </button>
        </form>

        <div style={styles.footer}>
          Need an account? <a href="/signup">Create a business account</a>
        </div>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  page: {
    minHeight: "100vh",
    position: "relative",
    overflow: "hidden",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
    background:
      "radial-gradient(1200px 700px at 25% 20%, rgba(156,108,255,0.28), transparent 55%)," +
      "radial-gradient(900px 700px at 80% 70%, rgba(91,31,166,0.24), transparent 55%)," +
      "#0b1020",
    color: "#0f172a",
  },
  elephants: {
    position: "absolute",
    inset: 0,
    pointerEvents: "none",
    backgroundRepeat: "repeat",
    backgroundPosition: "center",
    filter: "none",
  },
  vignette: {
    position: "absolute",
    inset: 0,
    pointerEvents: "none",
    background:
      "radial-gradient(circle at center, rgba(0,0,0,0) 0%, rgba(0,0,0,0.35) 70%, rgba(0,0,0,0.55) 100%)",
  },
  card: {
    width: "100%",
    maxWidth: 460,
    background: "rgba(255,255,255,0.92)",
    border: "1px solid rgba(15,23,42,0.10)",
    borderRadius: 18,
    padding: "22px 22px 18px",
    boxShadow: "0 18px 50px rgba(2,6,23,0.35)",
    position: "relative",
    zIndex: 1,
    backdropFilter: "blur(6px)",
  },
  h1: { fontSize: 28, fontWeight: 900, margin: "0 0 6px" },
  p: { opacity: 0.8, margin: "0 0 12px" },
  form: { marginTop: 10, display: "grid", gap: 10 },
  input: {
    padding: "12px 12px",
    borderRadius: 12,
    border: "1px solid rgba(15,23,42,0.14)",
    background: "#f8fafc",
    outline: "none",
    height: 46,
  },
  err: { color: "crimson", fontSize: 14 },
  button: {
    padding: 12,
    borderRadius: 999,
    border: "none",
    fontWeight: 800,
    cursor: "pointer",
    height: 46,
    color: "#fff",
    background: "linear-gradient(135deg, #0f172a, #5b1fa6)",
    boxShadow: "0 12px 24px rgba(2,6,23,0.25)",
  },
  footer: { marginTop: 14, fontSize: 14, opacity: 0.9 },
}; 
