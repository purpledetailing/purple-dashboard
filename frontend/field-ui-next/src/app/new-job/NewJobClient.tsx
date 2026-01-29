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

type Vehicle = {
  id: string;
  vin: string;
  year: number | null;
  make: string | null;
  model: string | null;
  trim: string | null;
  service_history_link?: string | null;
};

type Customer = {
  id: string;
  full_name: string;
  phone: string | null;
  phone_norm: string | null;
  address?: string | null;
  zip_code?: string | null;
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

/** VIN utils */
function normalizeVin(raw: string) {
  return (raw || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}
function isValidVin(vin: string) {
  // Standard VIN excludes I, O, Q
  return /^[A-HJ-NPR-Z0-9]{17}$/.test(vin);
}

function normalizePhone(raw: string) {
  const digits = (raw || "").replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  return digits;
}

function maskVin(vin17: string) {
  const v = normalizeVin(vin17);
  if (v.length !== 17) return vin17;
  return `•••• ${v.slice(-6)}`;
}

function vehicleLabel(v: Vehicle) {
  const parts = [v.year, v.make, v.model, v.trim].filter(Boolean).join(" ");
  return parts || "Vehicle";
}

type Step = 1 | 2 | 3 | 4;

type PendingJob = {
  id: string;
  created_at: string;
  attempt_count: number;

  vin: string;
  customer_name: string;
  customer_phone: string;

  customer_address: string;
  customer_zip: string;

  service_history_link: string;
  service_type: "full" | "interior" | "exterior" | "ceramic";
  selected_package_id: string;
  addon_ids: string[];
  total_charged: string;
  notes: string;
  performed_at: string;
};

const OFFLINE_QUEUE_KEY = "purple_field_offline_jobs_v1";

function isOnline() {
  return typeof navigator === "undefined" ? true : navigator.onLine;
}

function safeParse<T>(raw: string | null, fallback: T): T {
  try {
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function getQueue(): PendingJob[] {
  if (typeof window === "undefined") return [];
  return safeParse<PendingJob[]>(localStorage.getItem(OFFLINE_QUEUE_KEY), []);
}

function setQueue(items: PendingJob[]) {
  if (typeof window === "undefined") return;
  localStorage.setItem(OFFLINE_QUEUE_KEY, JSON.stringify(items));
}

function makeId() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const c: any = typeof crypto !== "undefined" ? crypto : null;
  if (c?.randomUUID) return c.randomUUID();
  return `${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function enqueueJob(item: Omit<PendingJob, "id" | "created_at" | "attempt_count">) {
  const q = getQueue();
  const newItem: PendingJob = {
    id: makeId(),
    created_at: new Date().toISOString(),
    attempt_count: 0,
    ...item,
  };
  q.unshift(newItem);
  setQueue(q);
  return newItem;
}

function removeFromQueue(id: string) {
  const q = getQueue().filter((x) => x.id !== id);
  setQueue(q);
}

function bumpAttempt(id: string) {
  const q = getQueue().map((x) => (x.id === id ? { ...x, attempt_count: x.attempt_count + 1 } : x));
  setQueue(q);
}

export default function NewJobClient() {
  return (
    <Protected>
      <NewJobInner />
    </Protected>
  );
}

function NewJobInner() {
  const router = useRouter();
  const { signOut } = useAuth();

  const [step, setStep] = useState<Step>(1);

  const [services, setServices] = useState<Service[]>([]);
  const [loadingServices, setLoadingServices] = useState(true);

  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [online, setOnline] = useState(true);
  const [queuedCount, setQueuedCount] = useState(0);
  const [syncingQueue, setSyncingQueue] = useState(false);

  const [vin, setVin] = useState("");
  const [vehicle, setVehicle] = useState<Vehicle | null>(null);
  const [vinStatus, setVinStatus] = useState<string>("");
  const [vinBusy, setVinBusy] = useState(false);

  const [customerName, setCustomerName] = useState("");
  const [customerPhone, setCustomerPhone] = useState("");
  const [customerAddress, setCustomerAddress] = useState("");
  const [customerZip, setCustomerZip] = useState("");
  const [serviceHistoryLink, setServiceHistoryLink] = useState("");

  const [serviceType, setServiceType] = useState<"full" | "interior" | "exterior" | "ceramic">("full");
  const [selectedPackageId, setSelectedPackageId] = useState<string>("");
  const [selectedAddonIds, setSelectedAddonIds] = useState<Record<string, boolean>>({});
  const [addonQuery, setAddonQuery] = useState("");

  const [addonsOpen, setAddonsOpen] = useState(false);

  const [totalCharged, setTotalCharged] = useState("");
  const [notes, setNotes] = useState("");

  const quickTotals = useMemo(() => ["200", "250", "300", "350", "400"], []);

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

  const filteredAddons = useMemo(() => {
    const q = addonQuery.trim().toLowerCase();
    if (!q) return addons;
    return addons.filter((a) => a.name.toLowerCase().includes(q));
  }, [addons, addonQuery]);

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

  const needsDecode = (veh: Vehicle | null) => {
    if (!veh) return true;
    return !veh.year || !veh.make || !veh.model;
  };

  function phoneToLegacyCustomerId(rawPhone: string) {
    const d = normalizePhone(rawPhone || "");
    if (!d) return null;
    const asNum = Number(d);
    return Number.isFinite(asNum) ? asNum : null;
  }

  function normalizeDriveFolderLink(raw: string) {
    const s = (raw || "").trim();
    if (!s) return "";
    if (!/^https?:\/\//i.test(s)) return s;
    return s;
  }

  // ✅ FIXED: no ON CONFLICT requirement; update-or-insert by vin
  async function upsertLegacyByVin(params: {
  vin: string;
  customerName: string;
  customerPhone: string;
  customerAddress?: string;
  customerZip?: string;
  vehicle: Vehicle | null;
  notes?: string;
  status?: string;
  serviceHistoryLink?: string;
}) {
  const v = normalizeVin(params.vin);

  if (!isValidVin(v)) {
    console.warn("Skipping legacy write for invalid VIN:", v);
    return;
  }

  const customer_id = phoneToLegacyCustomerId(params.customerPhone);

  const typedAddress = (params.customerAddress || "").trim() || null;
  const typedZip = (params.customerZip || "").trim() || null;

  // Write to multiple possible legacy column names so Secure always finds it
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const payload: any = {
    vin: v,
    customer_id,
    status: params.status ?? "active",
    notes: (params.notes || "").trim() || null,

    // common names
    customer_name: (params.customerName || "").trim() || null,
    phone_number: (params.customerPhone || "").trim() || null,
    address: typedAddress,
    zip_code: typedZip,

    // alternate names (in case Secure uses these)
    customer_phone: (params.customerPhone || "").trim() || null,
    customer_address: typedAddress,
    customer_zip: typedZip,
    zip: typedZip,
    postal_code: typedZip,

    make: params.vehicle?.make ?? null,
    model: params.vehicle?.model ?? null,
    year: params.vehicle?.year ?? null,
  };

  const link = normalizeDriveFolderLink(params.serviceHistoryLink || "");
  if (link) {
    payload.service_history_link = link;
  }

  // Update-or-insert by VIN (no unique constraint required)
  const { data: existing, error: findErr } = await supabase
    .from("customer_data_legacy")
    .select("id, vin")
    .eq("vin", v)
    .limit(1)
    .maybeSingle();

  if (findErr) throw findErr;

  if (existing?.id) {
    const { error: updErr } = await supabase.from("customer_data_legacy").update(payload).eq("id", existing.id);
    if (updErr) throw updErr;
  } else {
    const { error: insErr } = await supabase.from("customer_data_legacy").insert(payload);
    if (insErr) throw insErr;
  }
}

  async function autofillLegacyLinkForVin(vin17: string) {
    const v = normalizeVin(vin17);
    if (!isValidVin(v)) return;

    const { data, error } = await supabase
      .from("customer_data_legacy")
      .select("service_history_link")
      .eq("vin", v)
      .limit(1)
      .maybeSingle();

    if (error) return;
    const link = (data as any)?.service_history_link as string | undefined;
    if (link && !serviceHistoryLink.trim()) setServiceHistoryLink(link);
  }

  const autofillCustomerFromVehicle = async (vehicleId: string) => {
    const { data, error } = await supabase
      .from("jobs")
      .select("id, performed_at, customers:customer_id (id, full_name, phone, phone_norm, address, zip_code)")
      .eq("vehicle_id", vehicleId)
      .order("performed_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) return;

    const cust = (data as any)?.customers as Customer | undefined;
    if (!cust) return;

    if (!customerName.trim()) setCustomerName(cust.full_name ?? "");
    if (!customerPhone.trim() && cust.phone) setCustomerPhone(cust.phone);

    // only autofill if empty so you can override onsite
    if (!customerAddress.trim() && cust.address) setCustomerAddress(String(cust.address));
    if (!customerZip.trim() && cust.zip_code) setCustomerZip(String(cust.zip_code));
  };

  const decodeVinAndUpdateVehicle = async (vehicleId: string, vin17: string) => {
    if (!isOnline()) {
      setVinStatus("Offline — will identify vehicle when back online.");
      return;
    }

    try {
      setVinBusy(true);
      setVinStatus("Identifying vehicle…");

      const res = await fetch(`/api/vin-decode?vin=${encodeURIComponent(vin17)}`);
      const decoded = await res.json();

      if (!res.ok) {
        setVinStatus(decoded?.error ? `Identify failed: ${decoded.error}` : "Identify failed.");
        return;
      }

      const patch = {
        year: decoded.year ?? null,
        make: decoded.make ?? null,
        model: decoded.model ?? null,
        trim: decoded.trim ?? null,
      };

      const { data, error } = await supabase
        .from("vehicles")
        .update(patch)
        .eq("id", vehicleId)
        .select("id,vin,year,make,model,trim")
        .single();

      if (error) {
        setVinStatus("Vehicle identified, but failed to save details.");
        return;
      }

      setVehicle(data as Vehicle);
      setVinStatus("Vehicle identified ✅");
    } catch {
      setVinStatus("Identify error.");
    } finally {
      setVinBusy(false);
    }
  };

  const lookupVin = async () => {
    if (vinBusy) return;

    setMsg(null);
    setVinStatus("");
    setVehicle(null);

    const v = normalizeVin(vin);

    if (!isValidVin(v)) {
      setVinStatus("VIN must be 17 characters (no I, O, Q).");
      return;
    }

    if (!isOnline()) {
      setVinStatus("Offline — continue. VIN will link when job syncs.");
      setStep(2);
      setTimeout(() => {
        const el = document.querySelector<HTMLInputElement>('input[name="customerName"]');
        el?.focus();
      }, 50);
      return;
    }

    setVinBusy(true);
    try {
      const { data, error } = await supabase
        .from("vehicles")
        .select("id,vin,year,make,model,trim,service_history_link")
        .eq("vin", v)
        .limit(1)
        .maybeSingle();

      if (error) {
        setMsg(error.message);
        return;
      }

      let veh: Vehicle | null = (data as Vehicle) ?? null;

      if (!veh) {
        setVinStatus("Adding vehicle…");
        const createdVeh = await supabase
          .from("vehicles")
          .insert({ vin: v })
          .select("id,vin,year,make,model,trim,service_history_link")
          .single();

        if (createdVeh.error) {
          const retry = await supabase
            .from("vehicles")
            .select("id,vin,year,make,model,trim,service_history_link")
            .eq("vin", v)
            .limit(1)
            .single();

          if (retry.error) {
            setMsg(createdVeh.error.message);
            return;
          }
          veh = retry.data as Vehicle;
        } else {
          veh = createdVeh.data as Vehicle;
        }
      }

      setVehicle(veh);
      setVinStatus("VIN linked ✅");

      await autofillCustomerFromVehicle(veh.id);
      await autofillLegacyLinkForVin(v);

      if (needsDecode(veh)) {
        await decodeVinAndUpdateVehicle(veh.id, v);
      }

      setStep(2);
      setTimeout(() => {
        const el = document.querySelector<HTMLInputElement>('input[name="customerName"]');
        el?.focus();
      }, 50);
    } finally {
      setVinBusy(false);
    }
  };

  const resetForm = () => {
    setStep(1);
    setVin("");
    setVehicle(null);
    setVinStatus("");

    setCustomerName("");
    setCustomerPhone("");
    setCustomerAddress("");
    setCustomerZip("");
    setServiceHistoryLink("");

    setServiceType("full");
    setSelectedAddonIds({});
    setAddonQuery("");
    setAddonsOpen(false);

    setTotalCharged("");
    setNotes("");

    if (packages[0]?.id) setSelectedPackageId(packages[0].id);
  };

  const canGoStep2 = () => isValidVin(normalizeVin(vin));
  const canGoStep3 = () => customerName.trim().length > 0;
  const canGoStep4 = () => !!selectedPackageId;

  const saveJobToSupabase = async (payload: PendingJob) => {
    const v = normalizeVin(payload.vin);

    if (!isValidVin(v)) throw new Error("Invalid VIN (must be 17 chars, no I/O/Q).");

    let vehicleId: string;
    let vehicleForDecode: Vehicle | null = null;

    const foundVeh = await supabase
      .from("vehicles")
      .select("id,vin,year,make,model,trim,service_history_link")
      .eq("vin", v)
      .limit(1)
      .maybeSingle();

    if (foundVeh.error) throw foundVeh.error;

    if (foundVeh.data?.id) {
      vehicleId = foundVeh.data.id;
      vehicleForDecode = foundVeh.data as Vehicle;
    } else {
      const createdVeh = await supabase
        .from("vehicles")
        .insert({ vin: v })
        .select("id,vin,year,make,model,trim,service_history_link")
        .single();

      if (createdVeh.error) {
        const retry = await supabase
          .from("vehicles")
          .select("id,vin,year,make,model,trim,service_history_link")
          .eq("vin", v)
          .limit(1)
          .single();

        if (retry.error) throw createdVeh.error;
        vehicleId = retry.data.id;
        vehicleForDecode = retry.data as Vehicle;
      } else {
        vehicleId = createdVeh.data.id;
        vehicleForDecode = createdVeh.data as Vehicle;
      }
    }

    if (isOnline() && needsDecode(vehicleForDecode)) {
      await decodeVinAndUpdateVehicle(vehicleId, v);

      const refreshed = await supabase
        .from("vehicles")
        .select("id,vin,year,make,model,trim,service_history_link")
        .eq("id", vehicleId)
        .single();

      if (!refreshed.error) {
        vehicleForDecode = refreshed.data as Vehicle;
      }
    }

    const link = normalizeDriveFolderLink(payload.service_history_link || "");
    if (link) {
      try {
        await supabase.from("vehicles").update({ service_history_link: link }).eq("id", vehicleId);
      } catch {
        // ignore
      }
    }

    const phoneNorm = normalizePhone(payload.customer_phone);
    let customerId: string;

    // Normalized, clean values
    const typedName = payload.customer_name.trim();
    const typedPhone = payload.customer_phone.trim();
    const typedAddress = payload.customer_address.trim() || null;
    const typedZip = payload.customer_zip.trim() || null;

    if (phoneNorm) {
      const existingCust = await supabase
        .from("customers")
        .select("id, full_name, phone, phone_norm, address, zip_code")
        .eq("phone_norm", phoneNorm)
        .limit(1)
        .maybeSingle();

      if (existingCust.error) throw existingCust.error;

      if (existingCust.data?.id) {
        customerId = existingCust.data.id;

        const shouldUpdate =
          (typedName && typedName !== (existingCust.data.full_name ?? "")) ||
          (typedPhone && typedPhone !== (existingCust.data.phone ?? "")) ||
          (typedAddress && typedAddress !== ((existingCust.data as any).address ?? null)) ||
          (typedZip && typedZip !== ((existingCust.data as any).zip_code ?? null));

        if (shouldUpdate) {
          await supabase
            .from("customers")
            .update({
              full_name: typedName || existingCust.data.full_name,
              phone: typedPhone || existingCust.data.phone,
              phone_norm: phoneNorm,
              address: typedAddress,
              zip_code: typedZip,
            })
            .eq("id", customerId);
        }
      } else {
        const createdCust = await supabase
          .from("customers")
          .insert({
            full_name: typedName,
            phone: typedPhone || null,
            phone_norm: phoneNorm,
            address: typedAddress,
            zip_code: typedZip,
          })
          .select("id")
          .single();

        if (createdCust.error) throw createdCust.error;
        customerId = createdCust.data.id;
      }
    } else {
      const createdCust = await supabase
        .from("customers")
        .insert({
          full_name: typedName,
          phone: typedPhone || null,
          phone_norm: null,
          address: typedAddress,
          zip_code: typedZip,
        })
        .select("id")
        .single();

      if (createdCust.error) throw createdCust.error;
      customerId = createdCust.data.id;
    }

    const totalCents = dollarsToCents(payload.total_charged);

    const jobRes = await supabase
      .from("jobs")
      .insert({
        customer_id: customerId,
        vehicle_id: vehicleId,
        status: "completed",
        performed_at: payload.performed_at,
        notes: payload.notes.trim() || null,
        total_price_cents: totalCents,
        currency: "USD",
      })
      .select("id")
      .single();

    if (jobRes.error) throw jobRes.error;

    const serviceRows = [payload.selected_package_id, ...payload.addon_ids].map((sid) => ({
      job_id: jobRes.data.id,
      service_id: sid,
      quantity: 1,
      final_price_cents: null,
      price_note: null,
    }));

    const jsRes = await supabase.from("job_services").insert(serviceRows);
    if (jsRes.error) throw jsRes.error;

    // ✅ legacy write includes address + zip
    // ✅ non-blocking so UI always confirms + resets even if legacy has issues
    try {
      await upsertLegacyByVin({
        vin: v,
        customerName: payload.customer_name,
        customerPhone: payload.customer_phone,
        customerAddress: payload.customer_address,
        customerZip: payload.customer_zip,
        vehicle: vehicleForDecode,
        notes: payload.notes,
        status: "active",
        serviceHistoryLink: link,
      });
    } catch (e) {
      console.error("Legacy write failed (non-blocking):", e);
    }

    return jobRes.data.id as string;
  };

  const flushQueue = async () => {
    if (!isOnline()) return;
    if (syncingQueue) return;

    const q = getQueue();
    if (q.length === 0) {
      setQueuedCount(0);
      return;
    }

    setSyncingQueue(true);
    try {
      const ordered = [...q].reverse();
      for (const item of ordered) {
        try {
          bumpAttempt(item.id);
          await saveJobToSupabase(item);
          removeFromQueue(item.id);
          setQueuedCount(getQueue().length);
        } catch (e) {
          console.error("Queue sync failed:", e);
          break;
        }
      }
    } finally {
      setSyncingQueue(false);
      setQueuedCount(getQueue().length);
    }
  };

  useEffect(() => {
    const refresh = () => {
      setOnline(isOnline());
      setQueuedCount(getQueue().length);
    };

    refresh();

    const onOnline = () => {
      refresh();
      flushQueue();
    };

    const onOffline = () => refresh();

    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);

    const interval = window.setInterval(() => {
      refresh();
      if (isOnline()) flushQueue();
    }, 20000);

    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
      window.clearInterval(interval);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onSave = async () => {
    setMsg(null);

    const v = normalizeVin(vin);
    if (!isValidVin(v)) return setMsg("VIN must be 17 characters (no I, O, Q).");
    if (!customerName.trim()) return setMsg("Customer name is required.");
    if (!selectedPackageId) return setMsg("Select a package.");
    const totalCents = dollarsToCents(totalCharged);
    if (totalCents <= 0) return setMsg("Total charged must be > $0.");

    const payloadBase = {
      vin: v,
      customer_name: customerName,
      customer_phone: customerPhone,
      customer_address: customerAddress,
      customer_zip: customerZip,
      service_history_link: serviceHistoryLink,
      service_type: serviceType,
      selected_package_id: selectedPackageId,
      addon_ids: Object.entries(selectedAddonIds)
        .filter(([, on]) => on)
        .map(([id]) => id),
      total_charged: totalCharged,
      notes,
      performed_at: new Date().toISOString(),
    };

    if (!isOnline()) {
      enqueueJob(payloadBase);
      setQueuedCount(getQueue().length);
      setMsg("Offline ✅ Saved to queue. It will sync automatically when you’re back online.");
      resetForm();
      return;
    }

    setBusy(true);
    try {
      const tempPending: PendingJob = {
        id: "live",
        created_at: new Date().toISOString(),
        attempt_count: 0,
        ...payloadBase,
      };

      await saveJobToSupabase(tempPending);
      setMsg("Saved ✅");
      resetForm();
      flushQueue();
    } catch (e: any) {
      console.error(e);

      const message = String(e?.message ?? "").toLowerCase();
      const likelyNetwork =
        !isOnline() ||
        message.includes("failed to fetch") ||
        message.includes("fetch") ||
        message.includes("network") ||
        message.includes("timeout");

      if (likelyNetwork) {
        enqueueJob(payloadBase);
        setQueuedCount(getQueue().length);
        setMsg("Connection issue ✅ Saved to queue. It will sync automatically.");
        resetForm();
      } else {
        setMsg(e?.message ?? "Error saving job.");
      }
    } finally {
      setBusy(false);
    }
  };

  const headerSubtitle = useMemo(() => {
    if (!vehicle) return "Fast capture while you’re onsite.";
    return `${vehicleLabel(vehicle)} • ${maskVin(vehicle.vin)}`;
  }, [vehicle]);

  const StepPill = ({ n, label }: { n: Step; label: string }) => {
    const active = step === n;
    const done = step > n;

    return (
      <button
        type="button"
        onClick={() => {
          if (n <= step) setStep(n);
        }}
        className={[
          "inline-flex items-center gap-2 rounded-full px-3 py-1 text-[11px] font-semibold transition touch-manipulation",
          active
            ? "bg-purple-600/15 text-purple-200 ring-1 ring-purple-500/30"
            : done
              ? "bg-white/5 text-slate-200 ring-1 ring-white/10 hover:ring-white/20"
              : "bg-white/3 text-slate-400 ring-1 ring-white/10",
        ].join(" ")}
      >
        <span
          className={[
            "inline-flex h-5 w-5 items-center justify-center rounded-full text-[11px]",
            active
              ? "bg-purple-500/20 text-purple-200 ring-1 ring-purple-400/30"
              : done
                ? "bg-white/10 text-slate-200 ring-1 ring-white/15"
                : "bg-white/5 text-slate-400 ring-1 ring-white/10",
          ].join(" ")}
        >
          {done ? "✓" : n}
        </span>
        {label}
      </button>
    );
  };

  const topStatus =
    !online ? (
      <div className="inline-flex items-center gap-2 rounded-full bg-amber-500/10 text-amber-200 ring-1 ring-amber-400/20 px-3 py-1 text-[11px] font-semibold">
        OFFLINE • Queue {queuedCount}
      </div>
    ) : queuedCount > 0 ? (
      <button
        type="button"
        onClick={flushQueue}
        className="inline-flex items-center gap-2 rounded-full bg-purple-500/10 text-purple-200 ring-1 ring-purple-400/20 px-3 py-1 text-[11px] font-semibold hover:bg-purple-500/15 transition touch-manipulation"
      >
        QUEUED {queuedCount} {syncingQueue ? "• Syncing…" : "• Tap to sync"}
      </button>
    ) : (
      <div className="inline-flex items-center gap-2 rounded-full bg-emerald-500/10 text-emerald-200 ring-1 ring-emerald-400/20 px-3 py-1 text-[11px] font-semibold">
        ONLINE
      </div>
    );

  return (
    <div className="min-h-[100dvh] text-slate-100 overscroll-contain">
      {/* Schema canvas */}
      <div className="fixed inset-0 -z-10 bg-slate-950">
        <div
          className="absolute inset-0 opacity-[0.08]"
          style={{
            backgroundImage:
              "linear-gradient(to right, rgba(255,255,255,0.08) 1px, transparent 1px), linear-gradient(to bottom, rgba(255,255,255,0.08) 1px, transparent 1px)",
            backgroundSize: "48px 48px",
          }}
        />
        <div className="absolute -top-40 left-1/2 h-[420px] w-[420px] -translate-x-1/2 rounded-full bg-purple-600/20 blur-[90px]" />
      </div>

      {/* Top bar */}
      <div className="sticky top-0 z-20 border-b border-white/10 bg-slate-950/80 backdrop-blur">
        <div className="mx-auto max-w-md px-4 py-3">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <div className="text-lg font-extrabold tracking-tight">
                  <span className="text-purple-300">Purple</span> Field
                </div>
                {topStatus}
              </div>

              <div className="mt-1 text-xs text-slate-300/80 truncate">{headerSubtitle}</div>

              <div className="mt-3 flex gap-2 overflow-x-auto pb-1">
                <StepPill n={1} label="VIN" />
                <StepPill n={2} label="Customer" />
                <StepPill n={3} label="Services" />
                <StepPill n={4} label="Total" />
              </div>
            </div>

            <button
              onClick={async () => {
                await signOut();
                router.replace("/login");
              }}
              className="shrink-0 rounded-full px-3 py-2 text-xs font-semibold ring-1 ring-white/10 text-slate-200 hover:ring-white/20 hover:text-white transition touch-manipulation"
            >
              Sign out
            </button>
          </div>

          {msg && (
            <div className="mt-3 rounded-2xl bg-white/5 ring-1 ring-white/10 px-3 py-2 text-xs text-slate-200">
              {msg}
            </div>
          )}
        </div>
      </div>

      {/* mobile-safe bottom padding */}
      <div className="mx-auto max-w-md px-4 pt-4 pb-[calc(7rem+env(safe-area-inset-bottom))]">
        {loadingServices ? (
          <SchemaCard title="Loading">
            <div className="text-sm text-slate-300">Loading services…</div>
          </SchemaCard>
        ) : (
          <div className="space-y-6">
            {/* STEP 1 */}
            {step === 1 && (
              <SchemaCard title="Vehicle VIN">
                <SchemaLabel>VIN</SchemaLabel>
                <div className="flex gap-2">
                  <SchemaInput
                    value={vin}
                    onChange={(e) => setVin(e.target.value)}
                    placeholder="17-character VIN"
                    inputMode="text"
                    autoCapitalize="characters"
                    autoCorrect="off"
                  />
                  <SchemaButton onClick={lookupVin} disabled={vinBusy || !normalizeVin(vin).length} variant="primary">
                    {vinBusy ? "…" : "Lookup"}
                  </SchemaButton>
                </div>

                <div className="mt-2 min-h-[18px] text-[11px] text-slate-300/80">
                  {vinStatus ? vinStatus : "Tip: Lookup links VIN and identifies vehicle (online)."}
                </div>

                <div className="mt-3 flex items-center justify-between rounded-2xl bg-white/5 ring-1 ring-white/10 px-4 py-3">
                  <div className="min-w-0">
                    <div className="text-sm font-semibold text-white/90 truncate">
                      {vehicle ? vehicleLabel(vehicle) : normalizeVin(vin).length ? "VIN entered" : "No vehicle yet"}
                    </div>
                    <div className="text-xs text-slate-300/70">
                      {vehicle ? maskVin(vehicle.vin) : normalizeVin(vin).length ? maskVin(vin) : "Enter VIN to begin"}
                    </div>
                  </div>

                  <button
                    type="button"
                    onClick={() => setStep(2)}
                    disabled={!canGoStep2()}
                    className={[
                      "text-sm font-semibold transition touch-manipulation",
                      canGoStep2() ? "text-purple-200 hover:text-purple-100" : "text-slate-500 cursor-not-allowed",
                    ].join(" ")}
                  >
                    Continue →
                  </button>
                </div>
              </SchemaCard>
            )}

            {/* STEP 2 */}
            {step === 2 && (
              <SchemaCard title="Customer">
                <SchemaLabel>Full name</SchemaLabel>
                <SchemaInput
                  name="customerName"
                  value={customerName}
                  onChange={(e) => setCustomerName(e.target.value)}
                  placeholder="Customer name"
                />

                <div className="mt-4">
                  <SchemaLabel>Phone (dedupe)</SchemaLabel>
                  <SchemaInput
                    value={customerPhone}
                    onChange={(e) => setCustomerPhone(e.target.value)}
                    placeholder="(919) 555-1234"
                    inputMode="tel"
                  />
                  <div className="mt-2 text-[11px] text-slate-300/70">Any format is fine — we normalize digits.</div>
                </div>

                <div className="mt-4">
                  <SchemaLabel>Address (optional)</SchemaLabel>
                  <SchemaInput
                    value={customerAddress}
                    onChange={(e) => setCustomerAddress(e.target.value)}
                    placeholder="123 Main St, Raleigh, NC"
                    inputMode="text"
                  />
                </div>

                <div className="mt-4">
                  <SchemaLabel>ZIP (optional)</SchemaLabel>
                  <SchemaInput
                    value={customerZip}
                    onChange={(e) => setCustomerZip(e.target.value)}
                    placeholder="27604"
                    inputMode="numeric"
                  />
                </div>

                <div className="mt-4">
                  <SchemaLabel>Google Drive folder link (optional)</SchemaLabel>
                  <SchemaInput
                    value={serviceHistoryLink}
                    onChange={(e) => setServiceHistoryLink(e.target.value)}
                    placeholder="https://drive.google.com/drive/folders/…"
                    inputMode="url"
                  />
                  <div className="mt-2 text-[11px] text-slate-300/70">
                    Paste the Drive <b>folder</b> link where photos live.
                  </div>
                </div>

                <div className="mt-5 flex gap-2">
                  <SchemaButton onClick={() => setStep(1)} variant="ghost">
                    ← Back
                  </SchemaButton>
                  <SchemaButton onClick={() => setStep(3)} disabled={!canGoStep3()} variant="primary">
                    Next
                  </SchemaButton>
                </div>
              </SchemaCard>
            )}

            {/* STEP 3 */}
            {step === 3 && (
              <SchemaCard title="Services">
                <SchemaLabel>Service type</SchemaLabel>
                <SchemaSelect value={serviceType} onChange={(e) => setServiceType(e.target.value as any)}>
                  <option value="full">Full Service</option>
                  <option value="interior">Interior</option>
                  <option value="exterior">Exterior</option>
                  <option value="ceramic">Ceramic</option>
                </SchemaSelect>

                <div className="mt-4">
                  <SchemaLabel>Package</SchemaLabel>
                  {packages.length === 0 ? (
                    <div className="h-12 flex items-center rounded-2xl bg-white/5 ring-1 ring-white/10 px-4 text-sm text-slate-300/70">
                      No packages found.
                    </div>
                  ) : (
                    <SchemaSelect value={selectedPackageId} onChange={(e) => setSelectedPackageId(e.target.value)}>
                      {packages.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </SchemaSelect>
                  )}
                </div>

                {/* Add-ons */}
                <div className="mt-5 pt-5 border-t border-white/10">
                  <button
                    type="button"
                    onClick={() => setAddonsOpen((v) => !v)}
                    className="w-full flex items-center justify-between rounded-2xl bg-white/5 ring-1 ring-white/10 px-4 py-3 hover:ring-white/20 transition touch-manipulation"
                  >
                    <div className="text-left">
                      <div className="text-sm font-extrabold text-white/90">Add-ons</div>
                      <div className="text-[11px] text-slate-300/70">{selectedAddons.length} selected</div>
                    </div>
                    <div className="text-slate-200 font-extrabold">{addonsOpen ? "−" : "+"}</div>
                  </button>

                  {selectedAddons.length > 0 && (
                    <div className="mt-3 flex flex-wrap gap-2">
                      {selectedAddons.map((a) => (
                        <button
                          key={a.id}
                          onClick={() => toggleAddon(a.id)}
                          className="rounded-full px-3 py-1.5 text-[11px] font-semibold bg-purple-500/10 text-purple-200 ring-1 ring-purple-400/20 hover:bg-purple-500/15 transition touch-manipulation"
                          type="button"
                        >
                          {a.name} ✕
                        </button>
                      ))}
                    </div>
                  )}

                  {addonsOpen && (
                    <div className="mt-3">
                      <SchemaInput
                        className="mt-1"
                        value={addonQuery}
                        onChange={(e) => setAddonQuery(e.target.value)}
                        placeholder="Search add-ons…"
                      />

                      <div className="mt-3 flex flex-wrap gap-2">
                        {filteredAddons.map((a) => {
                          const on = !!selectedAddonIds[a.id];
                          const hint = suggestedRangeText(a);
                          const note = a.price_note || "";
                          const sub = [hint, note].filter(Boolean).join(" • ");

                          return (
                            <button
                              key={a.id}
                              type="button"
                              onClick={() => toggleAddon(a.id)}
                              className={[
                                "text-left rounded-2xl px-3 py-2 ring-1 transition touch-manipulation",
                                on
                                  ? "bg-purple-500/15 ring-purple-400/25 text-purple-100"
                                  : "bg-white/5 ring-white/10 text-white/90 hover:ring-white/20",
                              ].join(" ")}
                            >
                              <div className="text-sm font-semibold">{a.name}</div>
                              {sub ? (
                                <div className={["text-[11px] mt-0.5", on ? "text-purple-100/70" : "text-slate-300/70"].join(" ")}>
                                  {sub}
                                </div>
                              ) : null}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>

                <div className="mt-5 flex gap-2">
                  <SchemaButton onClick={() => setStep(2)} variant="ghost">
                    ← Back
                  </SchemaButton>
                  <SchemaButton onClick={() => setStep(4)} disabled={!canGoStep4()} variant="primary">
                    Next
                  </SchemaButton>
                </div>
              </SchemaCard>
            )}

            {/* STEP 4 */}
            {step === 4 && (
              <SchemaCard title="Total & Notes">
                <SchemaLabel>Total charged</SchemaLabel>
                <div className="flex items-center gap-2">
                  <div className="h-12 w-10 rounded-2xl bg-white/5 ring-1 ring-white/10 flex items-center justify-center text-slate-300/80 font-semibold">
                    $
                  </div>
                  <SchemaInput value={totalCharged} onChange={(e) => setTotalCharged(e.target.value)} placeholder="250" inputMode="decimal" />
                </div>

                <div className="mt-3 flex flex-wrap gap-2">
                  {quickTotals.map((v) => (
                    <button
                      key={v}
                      type="button"
                      onClick={() => setTotalCharged(v)}
                      className="rounded-full px-3 py-1.5 text-[11px] font-semibold bg-white/5 ring-1 ring-white/10 hover:ring-white/20 transition touch-manipulation"
                    >
                      ${v}
                    </button>
                  ))}
                </div>

                <div className="mt-4">
                  <SchemaLabel>Notes (optional)</SchemaLabel>
                  <textarea
                    className="w-full min-h-[120px] rounded-2xl bg-white/5 ring-1 ring-white/10 px-4 py-3 text-base text-white/90 placeholder:text-slate-400/70 focus:outline-none focus:ring-2 focus:ring-purple-400/30"
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    placeholder="Anything important…"
                  />
                </div>

                <div className="mt-5 flex gap-2">
                  <SchemaButton onClick={() => setStep(3)} variant="ghost">
                    ← Back
                  </SchemaButton>
                  <SchemaButton onClick={onSave} disabled={busy} variant="primary">
                    {busy ? "Saving…" : "Save"}
                  </SchemaButton>
                </div>
              </SchemaCard>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** Schema UI components */

function SchemaCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-3xl bg-white/[0.03] ring-1 ring-white/10 overflow-hidden">
      <div className="px-4 py-3 border-b border-white/10 flex items-center justify-between">
        <div className="text-sm font-extrabold tracking-tight text-white/90">{title}</div>
        <div className="h-2 w-2 rounded-full bg-purple-400/70 shadow-[0_0_16px_rgba(168,85,247,0.35)]" />
      </div>
      <div className="p-4">{children}</div>
    </div>
  );
}

function SchemaLabel({ children }: { children: React.ReactNode }) {
  return <div className="text-[11px] font-semibold text-slate-300/80 mb-2">{children}</div>;
}

function SchemaInput(props: React.InputHTMLAttributes<HTMLInputElement> & { className?: string }) {
  const { className, ...rest } = props;
  return (
    <input
      {...rest}
      className={[
        "h-12 w-full rounded-2xl bg-white/5 ring-1 ring-white/10 px-4 text-base text-white/90 placeholder:text-slate-400/70",
        "focus:outline-none focus:ring-2 focus:ring-purple-400/30",
        className ?? "",
      ].join(" ")}
    />
  );
}

function SchemaSelect(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      {...props}
      className={[
        "h-12 w-full rounded-2xl bg-white/5 ring-1 ring-white/10 px-4 text-base text-white/90",
        "focus:outline-none focus:ring-2 focus:ring-purple-400/30",
      ].join(" ")}
    />
  );
}

function SchemaButton({
  children,
  onClick,
  disabled,
  variant,
  className,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  variant: "primary" | "ghost";
  className?: string;
}) {
  const base = "h-12 rounded-2xl font-extrabold text-sm transition ring-1 touch-manipulation";
  const width = className?.includes("w-") ? "" : "w-full";
  const cls =
    variant === "primary"
      ? disabled
        ? "bg-white/5 text-slate-500 cursor-not-allowed ring-white/10"
        : "bg-purple-500/15 text-purple-100 ring-purple-400/25 hover:bg-purple-500/20"
      : "bg-white/3 text-slate-200 ring-white/10 hover:ring-white/20 hover:text-white";

  return (
    <button onClick={onClick} disabled={!!disabled} className={[base, width, cls, className ?? ""].join(" ")}>
      {children}
    </button>
  );
}
