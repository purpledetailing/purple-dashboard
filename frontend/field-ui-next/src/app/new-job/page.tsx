"use client";

import { Protected } from "@/components/Protected";

export default function NewJobPage() {
  return (
    <Protected>
      <div style={{ padding: 24 }}>
        <h1>New Job</h1>
        <p>If you see this, routing is working.</p>
      </div>
    </Protected>
  );
}
