"use client";

import { useState } from "react";
import { supabase } from "@/lib/supabaseClient";
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

    try {
      // 1) Create auth user
      const { data, error } = await supabase.auth.signUp({
        email: email.trim(),
        password,
        options: {
          data: {
            full_name: fullName.trim(),
            business_name: businessName.trim(),
          },
        },
      });

      if (error) throw error;

      // IMPORTANT: If email confirmations are ON, session may be null here.
      const userId = data.user?.id;
      if (!userId) {
        throw new Error(
          "Signup created no user id (email confirmation may be enabled). Check Supabase Auth settings."
        );
      }

      // 2) Create the business row
      const { data: biz, error: bizErr } = await supabase
        .from("businesses")
        .insert({
          name: businessName.trim(),
          owner_user_id: userId, // match your column name
        })
        .select("id")
        .single();

      if (bizErr) throw bizErr;

      // 3) Link the user to the business
      const { error: linkErr } = await supabase.from("business_users").insert({
        business_id: biz.id,
        user_id: userId,
        role: "owner",
      });

      if (linkErr) throw linkErr;

      // 4) Send to field tool
      router.replace("/new-job");
    } catch (e: any) {
      console.error("SIGNUP FAILED:", e);
      setErr(e?.message ?? "Signup failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{ maxWidth: 520, margin: "48px auto", padding: 16 }}>
      <h1 style={{ fontSize: 34, fontWeight: 900 }}>Create Business Account</h1>

      <form onSubmit={onSignup} style={{ display: "grid", gap: 10, marginTop: 18 }}>
        <input value={businessName} onChange={(e) => setBusinessName(e.target.value)} placeholder="Business name" />
        <input value={fullName} onChange={(e) => setFullName(e.target.value)} placeholder="Your name" />
        <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Email" />
        <input value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Password" type="password" />

        {err && <div style={{ color: "crimson" }}>{err}</div>}

        <button disabled={loading} style={{ padding: 12, borderRadius: 999, fontWeight: 800 }}>
          {loading ? "Creating..." : "Create Account"}
        </button>
      </form>
    </div>
  );
} 
