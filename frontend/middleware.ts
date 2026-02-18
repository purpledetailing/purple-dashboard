import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // Public routes
  const isPublic =
    pathname.startsWith("/login") ||
    pathname.startsWith("/signup") ||
    pathname.startsWith("/auth") || // email confirm callback routes, if you have them
    pathname.startsWith("/_next") ||
    pathname.startsWith("/favicon.ico");

  if (isPublic) return NextResponse.next();

  // Protect these routes (add more if needed)
  const isProtected = pathname.startsWith("/new-job") || pathname.startsWith("/dashboard");

  if (!isProtected) return NextResponse.next();

  // Supabase auth cookie names commonly include "sb-"
  const cookieNames = req.cookies.getAll().map((c) => c.name);
  const hasSupabaseAuthCookie = cookieNames.some((n) => n.startsWith("sb-"));

  if (!hasSupabaseAuthCookie) {
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    url.searchParams.set("next", pathname);
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
}; 
