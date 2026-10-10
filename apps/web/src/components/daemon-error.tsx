export function DaemonError({ message }: { message: string }) {
  return (
    <div
      role="alert"
      className="rounded-xl border border-warn-line bg-warn-soft p-5 text-sm text-warn"
    >
      {message}
    </div>
  );
}
