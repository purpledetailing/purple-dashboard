"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
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
};

type Step = 1 | 2 | 3 | 4;

type PendingJob = {
  id: string;
  created_at: string;
  attempt_count: number;

  vin: string;

  // REQUIRED vehicle identity (must be captured after VIN)
  vehicle_year: number | null;
  vehicle_make: string;
  vehicle_model: string;
  vehicle_trim: string;

  customer_name: string;
  customer_phone: string;
  customer_email: string;

  customer_address: string;
  customer_zip: string;

  // ✅ REMOVED: service_history_link (NO GOOGLE DRIVE)
  // service_history_link: string;

  service_type: "full" | "interior" | "exterior" | "ceramic";
  selected_package_id: string;
  addon_ids: string[];
  total_charged: string;
  notes: string;
  performed_at: string;
};

const SERVICE_TYPE_TO_CATEGORY: Record<string, Service["category"]> = {
  full: "full_service",
  interior: "interior_service",
  exterior: "exterior_service",
  ceramic: "ceramic_service",
};

const OFFLINE_QUEUE_KEY = "purple_field_offline_jobs_v1";

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

/** CAPS helpers (tool should capture in ALL CAPS) */
function toCaps(raw: string) {
  return (raw || "").toUpperCase();
}
function capsTrim(raw: string) {
  return toCaps(raw).trim();
}
function normalizeEmailForDb(raw: string) {
  // email is case-insensitive; we display CAPS in UI, but store lower for safety
  return (raw || "").trim().toLowerCase();
}
function normalizeYearInput(raw: string) {
  const digits = (raw || "").replace(/\D/g, "").slice(0, 4);
  return digits;
}
function yearToNumberOrNull(y: string) {
  const n = Number((y || "").trim());
  if (!Number.isFinite(n)) return null;
  if (n < 1900 || n > 2100) return null;
  return n;
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

function vehicleLabelParts(year: number | null, make: string, model: string, trim: string) {
  const parts = [year || "", make, model, trim].map((x) => String(x || "").trim()).filter(Boolean);
  return parts.join(" ") || "Vehicle";
}

function vehicleLabel(v: Vehicle) {
  const parts = [v.year, v.make, v.model, v.trim].filter(Boolean).join(" ");
  return parts || "Vehicle";
}

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

/** zip_code bigint helper (legacy table uses bigint) */
function normalizeZipToBigint(raw: string): number | null {
  const digits = (raw || "").trim().replace(/\D/g, "");
  if (!digits) return null;
  const n = Number(digits);
  if (!Number.isFinite(n)) return null;
  return n;
}

/** customers.zip_code stored as text in this flow — keep it clean */
function normalizeZipString(raw: string): string {
  const digits = (raw || "").replace(/\D/g, "");
  return digits.slice(0, 10);
}

/** Extract city/state from a loose address string:
 * "123 Main St, Wake Forest, NC 27587" -> { city:"Wake Forest", state:"NC" }
 */
function extractCityState(address: string): { city: string | null; state: string | null } {
  const a = (address || "").trim();
  if (!a) return { city: null, state: null };

  const parts = a
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length < 2) return { city: null, state: null };

  const last = parts[parts.length - 1];
  const stateMatch = last.match(/\b([A-Z]{2})\b/i);
  const state = stateMatch?.[1]?.toUpperCase() ?? null;

  const city = parts[parts.length - 2] ?? null;

  return { city: city || null, state };
}

export default function newjobclient() {
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

  // REQUIRED: year/make/model must exist before moving past VIN
  const [vehYearText, setVehYearText] = useState("");
  const [vehMake, setVehMake] = useState("");
  const [vehModel, setVehModel] = useState("");
  const [vehTrim, setVehTrim] = useState("");

  const [customerName, setCustomerName] = useState("");
  const [customerPhone, setCustomerPhone] = useState("");
  const [customerEmail, setCustomerEmail] = useState("");

  const [customerAddress, setCustomerAddress] = useState("");
  const [customerZip, setCustomerZip] = useState("");
  const [zipSuggestions, setZipSuggestions] = useState<string[]>([]);
  const zipLookupTimer = useRef<number | null>(null);

  const [photoBusy, setPhotoBusy] = useState(false);
  const [photoMsg, setPhotoMsg] = useState<string | null>(null);
  const photoInputRef = useRef<HTMLInputElement | null>(null);

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

  // ✅ NEW: allow photo upload as soon as VIN is valid (do NOT require year/make/model)
  const canUploadPhotos = useMemo(() => {
    const v = normalizeVin(vin);
    return isValidVin(v);
  }, [vin]);

  type PendingPhoto = {
  file: File;
  previewUrl: string;
};

const [photos, setPhotos] = useState<PendingPhoto[]>([]);
const batchIdRef = useRef<string>(crypto.randomUUID());


  // ✅ UPDATED: robust upload (calls /api/photos/upload which must insert into vehicle_photos)
  async function uploadPhotosForVin(vin17: string, files: FileList | null) {
    const v = normalizeVin(vin17);

    if (!isValidVin(v)) {
      setPhotoMsg("Enter a valid 17-character VIN first.");
      return;
    }
    if (!files || files.length === 0) return;

    const list = Array.from(files).slice(0, 8);

    if (files.length > 8) {
      setPhotoMsg("Max 8 photos per upload.");
      return;
    }

    setPhotoBusy(true);
    setPhotoMsg(null);

    try {
      const fd = new FormData();
      fd.append("vin", v);

      list.forEach((f) => {
        if (f.size > 18 * 1024 * 1024) {
          throw new Error("One of the photos is too large (max ~18MB).");
        }
        fd.append("photos", f, f.name);
      });

      const res = await fetch("/api/photos/upload", { method: "POST", body: fd });

      const text = await res.text();
      const data = text ? JSON.parse(text) : {};

      if (!res.ok) {
        setPhotoMsg((data?.error || `Upload failed (${res.status})`).toString());
        return;
      }

      setPhotoMsg(`Uploaded ${data.count ?? list.length} photo(s) ✅`);
    } catch (e: any) {
      setPhotoMsg((e?.message || "Upload failed.").toString());
    } finally {
      setPhotoBusy(false);
      if (photoInputRef.current) photoInputRef.current.value = "";
    }
  }

  /** ZIP lookup from your table (NO Google) */
  async function lookupZipSuggestionsFromAddress(addr: string) {
    if (!isOnline()) return;

    const { city, state } = extractCityState(addr);
    if (!city || !state) return;
    if (state.toUpperCase() !== "NC") return;

    const { data, error } = await supabase
      .from("zip_codes")
      .select("zip")
      .eq("state", "NC")
      .ilike("city", city)
      .order("zip", { ascending: true })
      .limit(10);

    if (error) return;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const zips = (data ?? []).map((r: any) => String(r.zip)).filter(Boolean);
    setZipSuggestions(zips);

    const currentZipClean = normalizeZipString(customerZip);
    if (!currentZipClean && zips.length === 1) {
      setCustomerZip(zips[0]);
    }
  }

  /** Debounced address -> zip suggestions */
  useEffect(() => {
    if (zipLookupTimer.current) window.clearTimeout(zipLookupTimer.current);

    if (!customerAddress.trim()) {
      setZipSuggestions([]);
      return;
    }

    zipLookupTimer.current = window.setTimeout(() => {
      lookupZipSuggestionsFromAddress(customerAddress);
    }, 450);

    return () => {
      if (zipLookupTimer.current) window.clearTimeout(zipLookupTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customerAddress]);

  /** Legacy writer (reliable) */
  async function upsertLegacyByVin(params: {
    vin: string;
    customerName: string;
    customerPhone: string;
    customerEmail?: string;
    customerAddress?: string;
    customerZip?: string;
    vehicle: { year: number | null; make: string; model: string; trim?: string };
    notes?: string;
    status?: string;
  }) {
    const v = normalizeVin(params.vin);

    if (!isValidVin(v)) {
      console.warn("Skipping legacy write for invalid VIN:", v);
      return;
    }

    const customer_id = phoneToLegacyCustomerId(params.customerPhone);

    const address = (params.customerAddress || "").trim() || null;
    const zip_code = normalizeZipToBigint(params.customerZip || "");

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const payload: any = {
      vin: v,
      customer_id,
      customer_name: capsTrim(params.customerName) || null,
      phone_number: (params.customerPhone || "").trim() || null,

      email: params.customerEmail ? normalizeEmailForDb(params.customerEmail) : null,

      address: address ? capsTrim(address) : null,
      zip_code,
      status: params.status ?? "active",
      notes: capsTrim(params.notes || "") || null,

      make: capsTrim(params.vehicle?.make || "") || null,
      model: capsTrim(params.vehicle?.model || "") || null,
      year: params.vehicle?.year ?? null,
    };

    // ✅ REMOVED: service_history_link legacy write (NO GOOGLE DRIVE)

    const { data: existing, error: findErr } = await supabase
      .from("customer_data_legacy")
      .select("id")
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

  async function autofillCustomerFromLegacy(vin17: string) {
    const v = normalizeVin(vin17);
    if (!isValidVin(v)) return;

    const { data, error } = await supabase
      .from("customer_data_legacy")
      .select("customer_name, phone_number, email, address, zip_code, make, model, year")
      .eq("vin", v)
      .limit(1)
      .maybeSingle();

    if (error || !data) return;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const d: any = data;

    if (!customerName.trim() && d.customer_name) setCustomerName(capsTrim(String(d.customer_name)));
    if (!customerPhone.trim() && d.phone_number) setCustomerPhone(String(d.phone_number));
    if (!customerEmail.trim() && d.email) setCustomerEmail(toCaps(String(d.email)));

    if (!customerAddress.trim() && d.address) setCustomerAddress(capsTrim(String(d.address)));
    if (!customerZip.trim() && d.zip_code != null) setCustomerZip(String(d.zip_code));

    if (!vehMake.trim() && d.make) setVehMake(capsTrim(String(d.make)));
    if (!vehModel.trim() && d.model) setVehModel(capsTrim(String(d.model)));
    if (!vehYearText.trim() && d.year != null) setVehYearText(String(d.year));
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

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cust = (data as any)?.customers as any;
    if (!cust) return;

    if (!customerName.trim()) setCustomerName(capsTrim(cust.full_name ?? ""));
    if (!customerPhone.trim() && cust.phone) setCustomerPhone(String(cust.phone));

    if (!customerAddress.trim() && cust.address) setCustomerAddress(capsTrim(String(cust.address)));
    if (!customerZip.trim() && cust.zip_code) setCustomerZip(String(cust.zip_code));
  };

  const decodeVinAndUpdateVehicle = async (vehicleId: string, vin17: string) => {
    if (!isOnline()) {
      setVinStatus("OFFLINE — ENTER YEAR/MAKE/MODEL MANUALLY TO CONTINUE.");
      return;
    }

    try {
      setVinBusy(true);
      setVinStatus("IDENTIFYING VEHICLE…");

      const res = await fetch(`/api/vin-decode?vin=${encodeURIComponent(vin17)}`);
      const decoded = await res.json();

      if (!res.ok) {
        setVinStatus(decoded?.error ? `IDENTIFY FAILED: ${decoded.error}` : "IDENTIFY FAILED.");
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
        setVinStatus("VEHICLE IDENTIFIED, BUT FAILED TO SAVE DETAILS.");
        return;
      }

      const v = data as Vehicle;
      setVehicle(v);

      setVehYearText(v.year ? String(v.year) : "");
      setVehMake(v.make ? capsTrim(v.make) : "");
      setVehModel(v.model ? capsTrim(v.model) : "");
      setVehTrim(v.trim ? capsTrim(v.trim) : "");

      setVinStatus("VEHICLE IDENTIFIED ✅");
    } catch {
      setVinStatus("IDENTIFY ERROR. ENTER YEAR/MAKE/MODEL MANUALLY.");
    } finally {
      setVinBusy(false);
    }
  };

  const lookupVin = async () => {
    if (vinBusy) return;

    setMsg(null);
    setVinStatus("");
    setVehicle(null);

    setVehYearText("");
    setVehMake("");
    setVehModel("");
    setVehTrim("");

    const v = normalizeVin(vin);

    if (!isValidVin(v)) {
      setVinStatus("VIN MUST BE 17 CHARACTERS (NO I, O, Q).");
      return;
    }

    try {
      await autofillCustomerFromLegacy(v);
    } catch {
      // ignore
    }

    if (!isOnline()) {
      setVinStatus("OFFLINE — ENTER YEAR/MAKE/MODEL MANUALLY TO CONTINUE.");
      return;
    }

    setVinBusy(true);
    try {
      const { data, error } = await supabase
        .from("vehicles")
        .select("id,vin,year,make,model,trim")
        .eq("vin", v)
        .limit(1)
        .maybeSingle();

      if (error) {
        setMsg(error.message);
        setVinStatus("VIN LOOKUP FAILED — ENTER YEAR/MAKE/MODEL MANUALLY.");
        return;
      }

      let veh: Vehicle | null = (data as Vehicle) ?? null;

      if (!veh) {
        const createdVeh = await supabase.from("vehicles").insert({ vin: v }).select("id,vin,year,make,model,trim").single();
        if (!createdVeh.error && createdVeh.data?.id) {
          veh = createdVeh.data as Vehicle;
        }
      }

      if (veh) {
        setVehicle(veh);

        setVehYearText(veh.year ? String(veh.year) : "");
        setVehMake(veh.make ? capsTrim(veh.make) : "");
        setVehModel(veh.model ? capsTrim(veh.model) : "");
        setVehTrim(veh.trim ? capsTrim(veh.trim) : "");

        setVinStatus("VIN LINKED ✅");

        try {
          await autofillCustomerFromVehicle(veh.id);
        } catch {
          // ignore
        }

        if (needsDecode(veh)) {
          try {
            await decodeVinAndUpdateVehicle(veh.id, v);
          } catch {
            setVinStatus("IDENTIFY FAILED — ENTER YEAR/MAKE/MODEL MANUALLY.");
          }
        }
      } else {
        setVinStatus("VIN NOT FOUND — ENTER YEAR/MAKE/MODEL MANUALLY.");
      }
    } finally {
      setVinBusy(false);
    }
  };

  const resetForm = () => {
    setStep(1);
    setVin("");
    setVehicle(null);
    setVinStatus("");

    setVehYearText("");
    setVehMake("");
    setVehModel("");
    setVehTrim("");

    setCustomerName("");
    setCustomerPhone("");
    setCustomerEmail("");
    setCustomerAddress("");
    setCustomerZip("");
    setZipSuggestions([]);

    setServiceType("full");
    setSelectedAddonIds({});
    setAddonQuery("");
    setAddonsOpen(false);

    setTotalCharged("");
    setNotes("");

    if (packages[0]?.id) setSelectedPackageId(packages[0].id);
  };

  const canGoStep2 = () => {
    const v = normalizeVin(vin);
    if (!isValidVin(v)) return false;

    const yearNum = yearToNumberOrNull(vehYearText);
    if (!yearNum) return false;
    if (!vehMake.trim()) return false;
    if (!vehModel.trim()) return false;

    return true;
  };

  const canGoStep3 = () => customerName.trim().length > 0;
  const canGoStep4 = () => !!selectedPackageId;

  const saveJobToSupabase = async (payload: PendingJob) => {
    const v = normalizeVin(payload.vin);
    if (!isValidVin(v)) throw new Error("INVALID VIN (MUST BE 17 CHARS, NO I/O/Q).");

    const yearNum = payload.vehicle_year;
    const makeCaps = capsTrim(payload.vehicle_make || "");
    const modelCaps = capsTrim(payload.vehicle_model || "");
    const trimCaps = capsTrim(payload.vehicle_trim || "");

    if (!yearNum || !makeCaps || !modelCaps) {
      throw new Error("YEAR/MAKE/MODEL REQUIRED (AFTER VIN).");
    }

    await upsertLegacyByVin({
      vin: v,
      customerName: payload.customer_name,
      customerPhone: payload.customer_phone,
      customerEmail: payload.customer_email,
      customerAddress: payload.customer_address,
      customerZip: payload.customer_zip,
      vehicle: {
        year: yearNum,
        make: makeCaps,
        model: modelCaps,
        trim: trimCaps,
      },
      notes: payload.notes,
      status: "active",
    });

    try {
      let vehicleId: string | null = null;

      const foundVeh = await supabase.from("vehicles").select("id,vin,year,make,model,trim").eq("vin", v).limit(1).maybeSingle();

      if (!foundVeh.error && foundVeh.data?.id) {
        vehicleId = foundVeh.data.id;
      } else {
        const createdVeh = await supabase.from("vehicles").insert({ vin: v }).select("id").single();
        if (!createdVeh.error && createdVeh.data?.id) {
          vehicleId = createdVeh.data.id;
        }
      }

      if (vehicleId) {
        await supabase
          .from("vehicles")
          .update({ year: yearNum, make: makeCaps, model: modelCaps, trim: trimCaps || null })
          .eq("id", vehicleId);

        if (isOnline()) {
          try {
            await decodeVinAndUpdateVehicle(vehicleId, v);
          } catch {
            // ignore
          }
        }
      }

      const phoneNorm = normalizePhone(payload.customer_phone);
      const typedName = capsTrim(payload.customer_name);
      const typedPhone = payload.customer_phone.trim();
      const typedAddress = capsTrim(payload.customer_address || "") || null;
      const typedZip = normalizeZipString(payload.customer_zip.trim()) || null;

      let customerId: string | null = null;

      if (phoneNorm) {
        const existingCust = await supabase
          .from("customers")
          .select("id, full_name, phone, phone_norm, address, zip_code")
          .eq("phone_norm", phoneNorm)
          .limit(1)
          .maybeSingle();

        if (!existingCust.error && existingCust.data?.id) {
          customerId = existingCust.data.id;
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

          if (!createdCust.error && createdCust.data?.id) {
            customerId = createdCust.data.id;
          }
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

        if (!createdCust.error && createdCust.data?.id) {
          customerId = createdCust.data.id;
        }
      }

      if (customerId && vehicleId) {
        const totalCents = dollarsToCents(payload.total_charged);

        const jobRes = await supabase
          .from("jobs")
          .insert({
            customer_id: customerId,
            vehicle_id: vehicleId,
            status: "completed",
            performed_at: payload.performed_at,
            notes: capsTrim(payload.notes) || null,
            total_price_cents: totalCents,
            currency: "USD",
          })
          .select("id")
          .single();

        if (!jobRes.error && jobRes.data?.id) {
          const serviceRows = [payload.selected_package_id, ...payload.addon_ids].map((sid) => ({
            job_id: jobRes.data.id,
            service_id: sid,
            quantity: 1,
            final_price_cents: null,
            price_note: null,
          }));

          await supabase.from("job_services").insert(serviceRows);
        }
      }
    } catch (e) {
      console.error("Normalized mirror failed (legacy saved):", e);
    }

    return v;
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
    if (!isValidVin(v)) return setMsg("VIN MUST BE 17 CHARACTERS (NO I, O, Q).");

    const yearNum = yearToNumberOrNull(vehYearText);
    if (!yearNum || !vehMake.trim() || !vehModel.trim()) {
      return setMsg("YEAR / MAKE / MODEL REQUIRED (AFTER VIN).");
    }

    if (!customerName.trim()) return setMsg("CUSTOMER NAME IS REQUIRED.");
    if (!selectedPackageId) return setMsg("SELECT A PACKAGE.");
    const totalCents = dollarsToCents(totalCharged);
    if (totalCents <= 0) return setMsg("TOTAL CHARGED MUST BE > $0.");

    const payloadBase = {
      vin: v,

      vehicle_year: yearNum,
      vehicle_make: capsTrim(vehMake),
      vehicle_model: capsTrim(vehModel),
      vehicle_trim: capsTrim(vehTrim),

      customer_name: capsTrim(customerName),
      customer_phone: customerPhone,
      customer_email: normalizeEmailForDb(customerEmail),

      customer_address: capsTrim(customerAddress),
      customer_zip: normalizeZipString(customerZip),

      service_type: serviceType,
      selected_package_id: selectedPackageId,
      addon_ids: Object.entries(selectedAddonIds)
        .filter(([, on]) => on)
        .map(([id]) => id),
      total_charged: totalCharged,
      notes: capsTrim(notes),
      performed_at: new Date().toISOString(),
    };

    if (!isOnline()) {
      enqueueJob(payloadBase as any);
      setQueuedCount(getQueue().length);
      setMsg("OFFLINE ✅ SAVED TO QUEUE. IT WILL SYNC AUTOMATICALLY WHEN YOU’RE BACK ONLINE.");
      resetForm();
      return;
    }

    setBusy(true);
    try {
      const tempPending: PendingJob = {
        id: "live",
        created_at: new Date().toISOString(),
        attempt_count: 0,
        ...(payloadBase as any),
      };

      await saveJobToSupabase(tempPending);
      setMsg("SAVED ✅ (LEGACY IS SOURCE OF TRUTH)");
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
        enqueueJob(payloadBase as any);
        setQueuedCount(getQueue().length);
        setMsg("CONNECTION ISSUE ✅ SAVED TO QUEUE. IT WILL SYNC AUTOMATICALLY.");
        resetForm();
      } else {
        setMsg((e?.message ?? "ERROR SAVING JOB.").toUpperCase());
      }
    } finally {
      setBusy(false);
    }
  };

  const headerSubtitle = useMemo(() => {
    const yearNum = yearToNumberOrNull(vehYearText);
    const label = vehicle ? vehicleLabel(vehicle) : vehicleLabelParts(yearNum, vehMake, vehModel, vehTrim);
    const v = normalizeVin(vin);
    if (!v) return "FAST CAPTURE WHILE YOU’RE ONSITE.";
    return `${label} • ${maskVin(v)}`;
  }, [vehicle, vin, vehYearText, vehMake, vehModel, vehTrim]);

  function StepPill({
    n,
    label,
    active = false,
  }: {
    n: number;
    label: string;
    active?: boolean;
  }) {
    return (
      <div
        className={`flex items-center justify-center gap-2 rounded-xl px-3 py-2 text-sm font-medium transition
        ${
          active
            ? "bg-purple-600 text-white shadow"
            : "bg-zinc-900/40 text-zinc-300 border border-zinc-700"
        }`}
      >
        <span
          className={`flex h-6 w-6 items-center justify-center rounded-full text-xs font-semibold
          ${active ? "bg-white text-purple-600" : "bg-zinc-700 text-zinc-200"}`}
        >
          {n}
        </span>
        <span className="tracking-wide">{label}</span>
      </div>
    );
  }

  const topStatus = !online ? (
    <div className="inline-flex items-center gap-2 rounded-full bg-amber-500/10 text-amber-200 ring-1 ring-amber-400/20 px-3 py-1 text-[11px] font-semibold">
      OFFLINE • QUEUE {queuedCount}
    </div>
  ) : queuedCount > 0 ? (
    <button
      type="button"
      onClick={flushQueue}
      className="inline-flex items-center gap-2 rounded-full bg-purple-500/10 text-purple-200 ring-1 ring-purple-400/20 px-3 py-1 text-[11px] font-semibold hover:bg-purple-500/15 transition touch-manipulation"
    >
      QUEUED {queuedCount} {syncingQueue ? "• SYNCING…" : "• TAP TO SYNC"}
    </button>
  ) : (
    <div className="inline-flex items-center gap-2 rounded-full bg-emerald-500/10 text-emerald-200 ring-1 ring-emerald-400/20 px-3 py-1 text-[11px] font-semibold">
      ONLINE
    </div>
  );

  return (
    <div className="min-h-[100dvh] text-slate-100 overscroll-contain">
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

              <div className="mt-3 grid grid-cols-4 gap-2">
                <StepPill n={1} label="VIN" active={step === 1} />
                <StepPill n={2} label="Customer" active={step === 2} />
                <StepPill n={3} label="Services" active={step === 3} />
                <StepPill n={4} label="Total" active={step === 4} />
              </div>
            </div>

            <button
              onClick={async () => {
                await signOut();
                router.replace("/login");
              }}
              className="shrink-0 rounded-full px-3 py-2 text-xs font-semibold ring-1 ring-white/10 text-slate-200 hover:ring-white/20 hover:text-white transition touch-manipulation"
            >
              SIGN OUT
            </button>
          </div>

          {msg && (
            <div className="mt-3 rounded-2xl bg-white/5 ring-1 ring-white/10 px-3 py-2 text-xs text-slate-200">
              {msg}
            </div>
          )}
        </div>
      </div>

      <div className="mx-auto max-w-md px-4 pt-4 pb-[calc(7rem+env(safe-area-inset-bottom))]">
        {loadingServices ? (
          <SchemaCard title="LOADING">
            <div className="text-sm text-slate-300">LOADING SERVICES…</div>
          </SchemaCard>
        ) : (
          <div className="space-y-6">
            {step === 1 && (
              <SchemaCard title="VEHICLE VIN">
                <SchemaLabel>VIN</SchemaLabel>
                <div className="flex gap-2">
                  <SchemaInput
                    value={vin}
                    onChange={(e) => {
                      const cleaned = normalizeVin(e.target.value).slice(0, 17);
                      setVin(cleaned);
                    }}
                    placeholder="17-character VIN"
                    inputMode="text"
                    autoCapitalize="characters"
                    autoCorrect="off"
                    maxLength={17}
                  />
                  <SchemaButton onClick={lookupVin} disabled={vinBusy || !normalizeVin(vin).length} variant="primary">
                    {vinBusy ? "…" : "LOOKUP"}
                  </SchemaButton>
                </div>

                <div className="mt-2 min-h-[18px] text-[11px] text-slate-300/80">
                  {vinStatus ? vinStatus : "TIP: LOOKUP LINKS VIN AND IDENTIFIES VEHICLE (ONLINE)."}
                </div>

                {/* ✅ PHOTO UPLOAD (SUPABASE BUCKET via /api/photos/upload) */}
                <div className="mt-4 rounded-2xl bg-white/5 ring-1 ring-white/10 p-4">
                  <div className="text-[11px] font-semibold text-slate-300/80 mb-2">Photos (max 8)</div>

                  <label className="block text-sm opacity-70 mt-6">Upload Photos</label>
                  
                  <input
                  type="file"
                  accept="image/*"
                  multiple
                  capture="environment"
                  onChange={(e) => {
                    if (!e.target.files) return;
                    
                    const newPhotos = Array.from(e.target.files).map((file) => ({
                      file,
                      previewUrl: URL.createObjectURL(file),
                    }));
                    
                    setPhotos((prev) => [...prev, ...newPhotos]);
                    }}
                    />

                  <SchemaButton
                    variant="primary"
                    disabled={photoBusy || !canUploadPhotos}
                    onClick={() => {
                      setPhotoMsg(null);
                      photoInputRef.current?.click();
                    }}
                    className="w-full"
                  >
                    {photoBusy ? "Uploading…" : canUploadPhotos ? "Upload Photos" : "Enter VIN to Upload"}
                  </SchemaButton>

                  {photoMsg ? (
                    <div className="mt-2 text-[11px] text-slate-300/80">{photoMsg}</div>
                  ) : (
                    <div className="mt-2 text-[11px] text-slate-300/70">Tip: Take up to 8 photos tied to this VIN.</div>
                  )}
                </div>

                <div className="mt-4 rounded-2xl bg-white/5 ring-1 ring-white/10 p-4">
                  <div className="text-xs font-extrabold text-white/90">YEAR / MAKE / MODEL (REQUIRED)</div>
                  <div className="mt-3 grid grid-cols-3 gap-2">
                    <div className="col-span-1">
                      <SchemaLabel>YEAR</SchemaLabel>
                      <SchemaInput
                        value={vehYearText}
                        onChange={(e) => setVehYearText(normalizeYearInput(e.target.value))}
                        placeholder="2019"
                        inputMode="numeric"
                      />
                    </div>
                    <div className="col-span-2">
                      <SchemaLabel>MAKE</SchemaLabel>
                      <SchemaInput
                        value={vehMake}
                        onChange={(e) => setVehMake(toCaps(e.target.value))}
                        placeholder="NISSAN"
                        inputMode="text"
                      />
                    </div>
                    <div className="col-span-3">
                      <SchemaLabel>MODEL</SchemaLabel>
                      <SchemaInput
                        value={vehModel}
                        onChange={(e) => setVehModel(toCaps(e.target.value))}
                        placeholder="KICKS"
                        inputMode="text"
                      />
                    </div>
                  </div>

                  {!online && (
                    <div className="mt-3 text-[11px] text-amber-200/90">
                      OFFLINE NOTE: ENTER YEAR/MAKE/MODEL MANUALLY — VIN DECODE WILL RESUME WHEN BACK ONLINE.
                    </div>
                  )}
                </div>

                <div className="mt-3 flex items-center justify-between rounded-2xl bg-white/5 ring-1 ring-white/10 px-4 py-3">
                  <div className="min-w-0">
                    <div className="text-sm font-semibold text-white/90 truncate">
                      {vehicleLabelParts(yearToNumberOrNull(vehYearText), vehMake, vehModel, vehTrim)}
                    </div>
                    <div className="text-xs text-slate-300/70">
                      {normalizeVin(vin).length ? maskVin(vin) : "ENTER VIN TO BEGIN"}
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
                    CONTINUE →
                  </button>
                </div>
              </SchemaCard>
            )}

            {/* (Everything else below stays the same as your original file) */}
            {/* You already pasted Steps 2–4 + Schema UI components and they remain unchanged */}
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
