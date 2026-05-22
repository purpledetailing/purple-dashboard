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

  // elephant asset
  const elephantUrl = useMemo(() => "/elephant.png", []);

  // elephant controls
  const ELEPHANT_SIZE_PX = 420;
  const ELEPHANT_OPACITY = 0.10;

  // redirect if active session exists
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

          if (ok) {
            router.replace("/new-job");
          }
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
    const { data: userRes, error: userErr } =
      await supabase.auth.getUser();

    if (userErr || !userRes.user) {
      setErr(userErr?.message ?? "Not logged in.");
      return false;
    }

    const user = userRes.user;

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
      return true;
    }

    let pending: PendingSignup | null = null;

    if (typeof window !== "undefined") {
      try {
        pending = JSON.parse(
          localStorage.getItem("pv_pending_signup") || "null"
        );
      } catch {}
    }

    const bizName =
      pending?.business_name?.trim() ||
      (user.user_metadata?.business_name as
        | string
        | undefined)?.trim() ||
      "";

    if (!bizName) {
      setErr("No business name found. Please sign up again.");
      return false;
    }

    const { data: newBizId, error: rpcErr } =
      await supabase.rpc(
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
      const { error } =
        await supabase.auth.signInWithPassword({
          email: email.trim(),
          password,
        });

      if (error) {
        setErr(error.message);
        return;
      }

      const ok = await ensureBusiness();

      if (!ok) return;

      const res = await fetch("/api/me");

      if (res.status === 403) {
        router.replace("/pending");
        return;
      }

      router.replace("/new-job");
    } catch (e: any) {
      setErr(e?.message ?? "Login failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={styles.page}>
      {/* elephant layer */}
      <div
        aria-hidden
        style={{
          ...styles.elephants,
          backgroundImage: `url("${elephantUrl}")`,
          backgroundSize: `${ELEPHANT_SIZE_PX}px ${ELEPHANT_SIZE_PX}px`,
          opacity: ELEPHANT_OPACITY,
        }}
      />

      {/* vignette */}
      <div
        aria-hidden
        style={styles.vignette}
      />

      <div style={styles.card}>
        <div style={styles.topLink}>
          <a
            href="https://purplevin.com"
            style={styles.topLinkAnchor}
          >
            ← PurpleVin.com
          </a>
        </div>

        <div style={styles.brand}>
          <span style={styles.brandPurple}>
            Purple
          </span>

          <span style={styles.brandBlack}>
            Vin
          </span>
        </div>

        <h1 style={styles.h1}>

        </h1>

        <p style={styles.p}>
          Secure access to PurpleVin Field Tool
        </p>

        <form
          onSubmit={onLogin}
          style={styles.form}
        >
          <input
            value={email}
            onChange={(e) =>
              setEmail(e.target.value)
            }
            placeholder="Email"
            autoComplete="email"
            style={styles.input}
          />

          <input
            value={password}
            onChange={(e) =>
              setPassword(e.target.value)
            }
            placeholder="Password"
            type="password"
            autoComplete="current-password"
            style={styles.input}
          />

          {err && (
            <div style={styles.err}>
              {err}
            </div>
          )}

          <button
            disabled={loading}
            style={{
              ...styles.button,
              opacity: loading ? 0.7 : 1,
            }}
          >
            {loading
              ? "Signing in..."
              : "Sign In"}
          </button>
        </form>

        <div style={styles.footer}>
          Need an account?{" "}
          <a href="/signup">
            Create a business account
          </a>
        </div>
      </div>
    </div>
  );
}

const styles: Record<
  string,
  React.CSSProperties
> = {
  page: {
    minHeight: "100vh",
    position: "relative",
    overflow: "hidden",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 24,

    background:
      "radial-gradient(1200px 700px at 25% 20%, rgba(156,108,255,0.22), transparent 55%)," +
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
      "radial-gradient(circle at center, rgba(0,0,0,0) 0%, rgba(0,0,0,0.22) 70%, rgba(0,0,0,0.42) 100%)",
  },

  card: {
    width: "100%",
    maxWidth: 480,

    background: "#ffffff",

    border:
      "1px solid rgba(15,23,42,0.08)",

    borderRadius: 24,

    padding: "26px 30px 24px",

    boxShadow:
      "0 22px 60px rgba(2,6,23,0.42)",

    position: "relative",
    zIndex: 1,
  },

  topLink: {
    marginBottom: 18,
  },

  topLinkAnchor: {
    color: "#7c3aed",
    textDecoration: "none",
    fontSize: 13,
    fontWeight: 700,
    opacity: 0.92,
  },

  brand: {
    textAlign: "center",

    fontSize: 36,
    fontWeight: 900,

    letterSpacing: "-0.05em",

    lineHeight: 1,

    marginBottom: 20,
  },

  brandPurple: {
    color: "#7c3aed",
  },

  brandBlack: {
    color: "#111827",
  },

  h1: {
    margin: 0,

    textAlign: "center",

    fontSize: 30,
    fontWeight: 900,

    lineHeight: 1.1,

    letterSpacing: "-0.04em",

    color: "#0f172a",
  },

  p: {
    margin: "10px 0 26px",

    color: "#64748b",

    fontSize: 14,

    lineHeight: 1.5,

    textAlign: "center",
  },

  form: {
    display: "grid",
    gap: 18,
  },

  input: {
    width: "100%",

    height: 50,

    borderRadius: 14,

    border:
      "1px solid rgba(15,23,42,0.12)",

    background: "#f8fafc",

    padding: "0 14px",

    outline: "none",

    fontSize: 15,
  },

  err: {
    color: "crimson",
    fontSize: 14,
  },

  button: {
    width: "100%",

    height: 52,

    borderRadius: 14,

    border: "none",

    fontWeight: 900,

    cursor: "pointer",

    color: "#fff",

    fontSize: 15,

    background:
      "linear-gradient(135deg, #7c3aed, #5b21b6)",

    boxShadow:
      "0 12px 24px rgba(91,33,182,0.28)",
  },

  footer: {
    marginTop: 22,

    paddingTop: 18,

    borderTop:
      "1px solid rgba(15,23,42,0.08)",

    fontSize: 13,

    opacity: 0.78,

    textAlign: "center",
  },
};
