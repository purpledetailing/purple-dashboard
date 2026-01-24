"use client";

import React, { useEffect, useMemo, useState } from "react";
import { Protected } from "@/components/Protected";
import { useAuth } from "@/components/AuthProvider";
import { supabase } from "@/lib/supabaseClient";
import { useRouter } from "next/navigation";

type Service = {
  id: string;
  name: string;
  category: "full_service" | "interior_service" | "exterior_service" | "ceramic_service" | "addon";
  pricing_type: "none" | "fixed" | "starting" | "range";
  price_cents: number | null;
  price_cents_max: number | null;
  price_note: string | null;
};

const SERVICE_TYPE_TO_CATEGORY: Record<string, Service["category"]> = {
  full: "full_service",
  interior: "interior_service",
  exterior: "exterior_service",
  ceramic: "ceramic_service",
};

function centsToDollars(cents: number | null) {
  if (cents === null || cents === undefined) return "";
  return (cents / 100).toFixed(2);
}

function dollarsToCents(input: string): number {
  const cleaned = input.replace(/[^0-9.]/g, "");
  if (!cleaned) return 0;
  const num = Number(cleaned);
  if (!Number.isFinite(num)) return 0;
  return Math.round(num * 100);
}

export default function NewJobPage() {
  return (
    <Protected>
      <NewJobInner />
    </Protected>
  );
}

function NewJobInner() {
  const router = useRouter();
  const { signOut } = useAuth();

  const [services, setServices] = useState<Service[]>([]);
  const [loadingServices, setLoadingServices] = useState(true);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Customer fields
  const [customerName, setCustomerName] = useState("");
  const [customerPhone, setCustomerPhone] = useState("");

  // Service selection
  const [serviceType, setServiceType] = useState<"full" | "interior" | "exterior" | "ceramic">("full");
  const [selectedPackageId, setSelectedPackageId] = useState<string>("");
  const [selectedAddonIds, setSelectedAddonIds] = useState<Record<string, boolean>>({});

  // Pricing + notes
  const [totalCharged, setTotalCharged] = useState("");
  const [notes, setNotes] = useState("");

  useEffect(() => {
    (async () => {
      setLoadingServices(true);
      setMsg(null);

      const { data, error } = await supabase
        .from("services")
        .select("id,name,category,pricing_type,price_cents,price_cents_max,price_note")
        .eq("active", true)
        .order("category", { ascending: true })
        .order("sort_order", { ascending: true })
        .order("name", { ascending: true });

      if (error) setMsg(error.message);
      setServices((data ?? []) as Service[]);
      setLoadingServices(false);
    })();
  }, []);

  const packageCategory = SERVICE_TYPE_TO_CATEGORY[serviceType];

  const packages = useMemo(() => services.filter((s) => s.category === packageCategory), [services, packageCategory]);
  const addons = useMemo(() => services.filter((s) => s.category === "addon"), [services]);

  // Auto-pick first package for chosen category
  useEffect(() => {
    if (packages.length === 0) {
      setSelectedPackageId("");
      return;
    }
    if (!selectedPackageId || !packages.some((p) => p.id === selectedPackageId)) {
      setSelectedPackageId(packages[0].id);
    }
  }, [packages, selectedPackageId]);

  const selectedAddons = useMemo(() => addons.filter((a) => selectedAddonIds[a.id]), [addons, selectedAddonIds]);

  const suggestedRangeText = (s: Service) => {
    if (s.pricing_type === "fixed" && s.price_cents != null) return `$${centsToDollars(s.price_cents)}`;
    if (s.pricing_type === "starting" && s.price_cents != null) return `from $${centsToDollars(s.price_cents)}`;
    if (s.pricing_type === "range" && s.price_cents != null && s.price_cents_max != null) {
      return `$${centsToDollars(s.price_cents)}–$${centsToDollars(s.price_cents_max)}`;
    }
    return "";
  };

  const toggleAddon = (id: string) => {
    setSelectedAddonIds((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  const resetForm = () => {
    setCustomerName("");
    setCustomerPhone("");
    setSelectedAddonIds({});
    setTotalCharged("");
    setNotes("");
    if (packages[0]?.id) setSelectedPackageId(packages[0].id);
  };

  const onSave = async () => {
    setMsg(null);

    if (!customerName.trim()) return setMsg("Customer name is required.");
    if (!selectedPackageId) return setMsg("Select a package.");
    const totalCents = dollarsToCents(totalCharged);
    if (totalCents <= 0) return setMsg("Total charged must be > $0.");

    setBusy(true);
    try {
      // 1) Create customer
      const { data: cust, error: custErr } = await supabase
        .from("customers")
        .insert({ full_name: customerName.trim(), phone: customerPhone.trim() || null })
        .select("id")
        .single();
      if (custErr) throw custErr;

      // 2) Create job
      const { data: job, error: jobErr } = await supabase
        .from("jobs")
        .insert({
          customer_id: cust.id,
          status: "completed",
          performed_at: new Date().toISOString(),
          notes: notes.trim() || null,
          total_price_cents: totalCents,
          currency: "USD",
        })
        .select("id")
        .single();
      if (jobErr) throw jobErr;

      // 3) Attach package + add-ons
      const addonIds = Object.entries(selectedAddonIds)
        .filter(([, v]) => v)
        .map(([id]) => id);

      const serviceRows = [selectedPackageId, ...addonIds].map((sid) => ({
        job_id: job.id,
        service_id: sid,
        quantity: 1,
        final_price_cents: null,
        price_note: null,
      }));

      const { error: jsErr } = await supabase.from("job_services").insert(serviceRows);
      if (jsErr) throw jsErr;

      setMsg("Saved ✅");
      resetForm();
    } catch (e: any) {
      console.error(e);
      setMsg(e?.message ?? "Error saving job.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-2xl p-4 pb-24">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-extrabold">New Job</h1>
          <p className="text-sm opacity-70">Quick capture while you’re onsite.</p>
        </div>

        <button
          onClick={async () => {
            await signOut();
            router.replace("/login");
          }}
          className="border rounded-xl px-3 py-2 text-sm hover:bg-black hover:text-white"
        >
          Sign out
        </button>
      </div>

      {loadingServices ? (
        <div className="mt-6 border rounded-2xl p-4">Loading services…</div>
      ) : (
        <div className="grid gap-4 mt-6">
          <Card title="Customer">
            <Field label="Full Name (required)">
              <input
                className="border rounded-xl p-3 w-full"
                value={customerName}
                onChange={(e) => setCustomerName(e.target.value)}
              />
            </Field>
            <Field label="Phone">
              <input
                className="border rounded-xl p-3 w-full"
                value={customerPhone}
                onChange={(e) => setCustomerPhone(e.target.value)}
              />
            </Field>
          </Card>

          <Card title="Services">
            <div className="grid gap-3">
              <Field label="Service Type">
                <select
                  className="border rounded-xl p-3 w-full"
                  value={serviceType}
                  onChange={(e) => setServiceType(e.target.value as any)}
                >
                  <option value="full">Full Service</option>
                  <option value="interior">Interior Service</option>
                  <option value="exterior">Exterior Service</option>
                  <option value="ceramic">Ceramic Service</option>
                </select>
              </Field>

              <Field label="Package (single select)">
                {packages.length === 0 ? (
                  <div className="border rounded-xl p-3 text-sm">
                    No packages found for this category. (Check your `services` table category values.)
                  </div>
                ) : (
                  <select
                    className="border rounded-xl p-3 w-full"
                    value={selectedPackageId}
                    onChange={(e) => setSelectedPackageId(e.target.value)}
                  >
                    {packages.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                )}
              </Field>

              <div className="mt-2 font-extrabold">Add-ons (multi-select)</div>
              <div className="grid gap-2">
                {addons.map((a) => {
                  const checked = !!selectedAddonIds[a.id];
                  const hint = suggestedRangeText(a);
                  const note = a.price_note || ""; // <-- avoids turbopack runtime weirdness

                  return (
                    <label key={a.id} className="flex items-center gap-3 border rounded-2xl p-3">
                      <input type="checkbox" checked={checked} onChange={() => toggleAddon(a.id)} />
                      <div className="flex-1">
                        <div className="font-semibold">{a.name}</div>

                        {(hint || note) ? (
                          <div className="text-xs opacity-70">
                            {hint}
                            {hint && note ? " • " : ""}
                            {note}
                          </div>
                        ) : null}
                      </div>
                    </label>
                  );
                })}
              </div>

              <div className="border rounded-2xl p-3 bg-black/5">
                <div className="font-semibold">Selected add-ons:</div>
                {selectedAddons.length === 0 ? (
                  <div className="text-sm opacity-70">None</div>
                ) : (
                  <ul className="text-sm list-disc pl-5">
                    {selectedAddons.map((a) => (
                      <li key={a.id}>{a.name}</li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          </Card>

          <Card title="Pricing & Notes">
            <Field label="Total Charged (required)">
              <input
                className="border rounded-xl p-3 w-full"
                value={totalCharged}
                onChange={(e) => setTotalCharged(e.target.value)}
                placeholder="e.g., 250"
              />
            </Field>
            <Field label="Notes (optional)">
              <textarea
                className="border rounded-xl p-3 w-full min-h-[100px]"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
              />
            </Field>
          </Card>

          <button
            onClick={onSave}
            disabled={busy}
            className="rounded-2xl p-4 font-extrabold border hover:bg-black hover:text-white disabled:opacity-50"
          >
            {busy ? "Saving…" : "Save Job"}
          </button>

          {msg && <div className="border rounded-2xl p-3 text-sm">{msg}</div>}
        </div>
      )}
    </div>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="border rounded-2xl p-4">
      <div className="font-extrabold mb-3">{title}</div>
      <div className="grid gap-3">{children}</div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="grid gap-2">
      <span className="text-sm opacity-80">{label}</span>
      {children}
    </label>
  );
}
