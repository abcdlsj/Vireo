import { useEffect, useState } from "react";
import { api, type Procedure } from "../api";
import { Markdown } from "../markdown";

/** A proposed reusable procedure; it is only used after the owner approves it (C10). */
export function ProcedureCard({ id, text, onChange }: { id: string; text: string; onChange: () => void }) {
  const [p, setP] = useState<Procedure | null>(null);
  const load = () =>
    api
      .get<{ procedures: Procedure[] }>("/api/procedures")
      .then((r) => setP(r.procedures.find((x) => x.id === id) ?? null))
      .catch(() => undefined);
  useEffect(() => {
    void load();
  }, [id]);
  if (!p) return <div className="notice">{text}</div>;
  const decide = async (d: "approve" | "reject") => {
    await api.post(`/api/procedures/${p.id}/${d}`);
    await load();
    onChange();
  };
  return (
    <div className="procedure-card" data-testid="procedure-card">
      <div className="action-head">
        <span className="action-kind">New procedure</span>
        <span className={`status-pill ${p.status}`}>{p.status === "proposed" ? "Proposed" : p.status === "approved" ? "Approved" : "Rejected"}</span>
      </div>
      <strong>{p.name}</strong>
      <p className="muted">{p.description}</p>
      <Markdown text={p.steps} />
      {p.status === "proposed" ? (
        <div className="action-buttons">
          <button className="btn primary" onClick={() => void decide("approve")}>
            Approve
          </button>
          <button className="btn ghost" onClick={() => void decide("reject")}>
            Not now
          </button>
        </div>
      ) : null}
    </div>
  );
}
