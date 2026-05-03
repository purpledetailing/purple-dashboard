export default function PendingPage() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-950 text-white px-6">
      <div className="max-w-md w-full text-center">
       
        {/* Glow */}
        <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[400px] h-[400px] bg-purple-600/20 blur-[120px] -z-10" />

        {/* Card */}
        <div className="bg-white/5 backdrop-blur rounded-3xl p-8 ring-1 ring-white/10 shadow-xl">
         
          <div className="text-2xl font-extrabold tracking-tight mb-2">
            <span className="text-purple-400">Purple</span> Access
          </div>

          <div className="text-lg font-semibold mb-4">
            Account Pending Approval
          </div>

          <p className="text-sm text-slate-300 mb-6">
            You're almost in. We’re reviewing your account now.
            <br />
            Typical approval time is within 24 hours.
          </p>

          <div className="text-xs text-slate-400 mb-6">
            You’ll receive access automatically once approved.
          </div>

          <a
            href="/login"
            className="inline-block w-full py-3 rounded-2xl bg-purple-500/15 text-purple-200 font-bold ring-1 ring-purple-400/30 hover:bg-purple-500/25 transition"
          >
            Back to Login
          </a>
        </div>
      </div>
    </div>
  );
}
