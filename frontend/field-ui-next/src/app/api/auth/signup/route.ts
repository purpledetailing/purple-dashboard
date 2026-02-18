import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export async function POST(req: Request) {
  const { email, password, businessName, fullName } = await req.json();

  // Service role required for creating user + writing tenant tables safely server-side
  const supabaseAdmin = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY! // server-only
  );

  // 1) Create auth user
  const { data: authData, error: authError } =
    await supabaseAdmin.auth.admin.createUser({
      email,
      password,
      email_confirm: true, // you can change later to require verification emails
    });

  if (authError || !authData.user) {
    return NextResponse.json(
      { error: authError?.message || "Failed to create user" },
      { status: 400 }
    );
  }

  const userId = authData.user.id;

  // 2) Create business
  const { data: biz, error: bizError } = await supabaseAdmin
    .from("businesses")
    .insert({ name: businessName })
    .select("id")
    .single();

  if (bizError || !biz) {
    return NextResponse.json(
      { error: bizError?.message || "Failed to create business" },
      { status: 400 }
    );
  }

  // 3) Create profile
  const { error: profileError } = await supabaseAdmin.from("profiles").insert({
    id: userId,
    email,
    full_name: fullName || null,
  });

  if (profileError) {
    return NextResponse.json(
      { error: profileError.message },
      { status: 400 }
    );
  }

  // 4) Create membership
  const { error: memError } = await supabaseAdmin.from("business_members").insert({
    business_id: biz.id,
    user_id: userId,
    role: "admin",
  });

  if (memError) {
    return NextResponse.json(
      { error: memError.message },
      { status: 400 }
    );
  }

  return NextResponse.json({ ok: true });
} 
