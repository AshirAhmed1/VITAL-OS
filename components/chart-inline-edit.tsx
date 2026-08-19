"use client";

import * as React from "react";
import { Plus, Trash2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { ChartNote, DemoMedication, DemoPatient, PatientProblem } from "@/lib/demo-patients";

export const ALLERGY_SEVERITIES = ["Mild", "Moderate", "Severe", "None"] as const;
export const MEDICATION_STATUSES = ["Active", "Hold", "Discontinued"] as const;
export const PROBLEM_STATUSES = [
  "Active",
  "Resolved",
  "Monitoring",
  "Pending",
  "Ruled out",
] as const;

export type AllergyRow = {
  allergen: string;
  reaction: string;
  severity: string;
};

const INPUT_CLASS =
  "w-full rounded-md border border-input bg-background px-1.5 py-0.5 text-sm text-foreground outline-none placeholder:text-muted-foreground focus:border-ring focus:ring-1 focus:ring-ring/30";

export function parseAllergyRow(entry: string): AllergyRow {
  const parts = entry.split(/[—–]/).map((s) => s.trim());
  if (parts.length >= 3) {
    return {
      allergen: parts[0] || "",
      reaction: parts[1] || "Noted",
      severity: parts[2] || "Mild",
    };
  }
  if (parts.length === 2) {
    const text = entry.toLowerCase();
    const severity = /anaphylaxis|severe/i.test(text)
      ? "Severe"
      : /rash|hives|swelling/i.test(text)
        ? "Moderate"
        : "Mild";
    return { allergen: parts[0] || "", reaction: parts[1] || "Noted", severity };
  }
  return { allergen: entry.trim(), reaction: "Noted", severity: "Mild" };
}

export function splitRiskFlags(value: string | undefined): string[] {
  if (!value?.trim()) return [];
  return value
    .split(/\.\s+/)
    .map((s) => s.replace(/\.$/, "").trim())
    .filter(Boolean);
}

export function joinRiskFlags(items: string[]): string {
  const cleaned = items.map((s) => s.trim().replace(/\.$/, "")).filter(Boolean);
  if (!cleaned.length) return "";
  return `${cleaned.join(". ")}.`;
}

export function notesFromPatient(patient: DemoPatient): ChartNote[] {
  if (patient.chartNotes?.length) return patient.chartNotes;
  if (patient.chartNote?.trim()) {
    return [
      {
        text: patient.chartNote.trim(),
        timestamp: new Date().toISOString(),
        provider: "Chart",
      },
    ];
  }
  return [];
}

type InlineFieldProps = {
  value: string;
  onCommit: (next: string) => void;
  disabled?: boolean;
  type?: "text" | "date" | "number";
  placeholder?: string;
  displayValue?: string;
  className?: string;
  inputClassName?: string;
  title?: string;
};

export function InlineField({
  value,
  onCommit,
  disabled,
  type = "text",
  placeholder,
  displayValue,
  className,
  inputClassName,
  title,
}: InlineFieldProps) {
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState(value);
  const inputRef = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    if (!editing) setDraft(value);
  }, [value, editing]);

  React.useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  const commit = () => {
    setEditing(false);
    const next = draft.trim();
    const current = value.trim();
    if (next === current) return;
    onCommit(type === "number" ? draft.trim() : next);
  };

  if (disabled) {
    return (
      <span className={cn("text-sm text-foreground", className)}>
        {displayValue ?? (value.trim() || placeholder || "—")}
      </span>
    );
  }

  if (!editing) {
    return (
      <button
        type="button"
        title={title ?? "Click to edit"}
        onClick={() => {
          setDraft(
            type === "date" && /^not listed$/i.test(value) ? "" : value
          );
          setEditing(true);
        }}
        className={cn(
          "w-full rounded-md px-0.5 py-0.5 text-left text-sm text-foreground hover:bg-muted/80",
          !(displayValue ?? value).trim() && "text-muted-foreground",
          className
        )}
      >
        {displayValue ?? (value.trim() || placeholder || "—")}
      </button>
    );
  }

  return (
    <input
      ref={inputRef}
      type={type}
      value={draft}
      placeholder={placeholder}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          commit();
        }
        if (e.key === "Escape") {
          setDraft(value);
          setEditing(false);
        }
      }}
      className={cn(INPUT_CLASS, inputClassName)}
    />
  );
}

type InlineSelectProps = {
  value: string;
  options: readonly string[];
  onCommit: (next: string) => void;
  disabled?: boolean;
  className?: string;
};

export function InlineSelect({
  value,
  options,
  onCommit,
  disabled,
  className,
}: InlineSelectProps) {
  const selectOptions =
    value && !options.includes(value) ? [value, ...options] : options;
  if (disabled) {
    return <span className={cn("text-sm text-foreground", className)}>{value || "—"}</span>;
  }
  return (
    <select
      value={value}
      onChange={(e) => {
        const next = e.target.value;
        if (next !== value) onCommit(next);
      }}
      className={cn(INPUT_CLASS, "h-7 cursor-pointer", className)}
    >
      {selectOptions.map((option) => (
        <option key={option} value={option}>
          {option}
        </option>
      ))}
    </select>
  );
}

function AddRowButton({
  label,
  onClick,
  disabled,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  if (disabled) return null;
  return (
    <button
      type="button"
      onClick={onClick}
      className="mt-2 inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
    >
      <Plus className="h-3 w-3" />
      {label}
    </button>
  );
}

function DeleteRowButton({
  onClick,
  disabled,
}: {
  onClick: () => void;
  disabled?: boolean;
}) {
  if (disabled) return null;
  return (
    <button
      type="button"
      onClick={onClick}
      title="Delete row"
      className="absolute right-1 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground opacity-0 hover:bg-muted hover:text-destructive group-hover:opacity-100"
    >
      <Trash2 className="h-3.5 w-3.5" />
    </button>
  );
}

export function EditableAllergyTable({
  allergies,
  canEdit,
  onSave,
}: {
  allergies: string[];
  canEdit: boolean;
  onSave: (next: AllergyRow[]) => void;
}) {
  const rows = React.useMemo(() => allergies.map(parseAllergyRow), [allergies]);
  const [drafts, setDrafts] = React.useState<AllergyRow[]>([]);
  const allRows = [...rows, ...drafts];

  const persist = (next: AllergyRow[]) => {
    onSave(next.filter((row) => row.allergen.trim()));
  };

  return (
    <div>
      <div className="rounded-xl border border-border">
        <div className="grid grid-cols-[1.5fr_1fr_1fr_1.5rem] border-b border-border bg-muted px-2 py-1 text-[11px] font-semibold text-foreground">
          <span>Allergen</span>
          <span>Reaction</span>
          <span>Severity</span>
          <span />
        </div>
        {allRows.length === 0 ? (
          <p className="px-2 py-2 text-xs text-muted-foreground">None listed</p>
        ) : (
          allRows.map((row, i) => {
            const isDraft = i >= rows.length;
            const draftIndex = i - rows.length;
            return (
              <div
                key={`all-${i}-${row.allergen}`}
                className="group relative grid grid-cols-[1.5fr_1fr_1fr_1.5rem] border-b border-border px-2 py-1.5 text-sm last:border-b-0"
              >
                <InlineField
                  value={row.allergen}
                  placeholder="Allergen"
                  disabled={!canEdit}
                  onCommit={(allergen) => {
                    if (isDraft) {
                      const nextDraft = { ...drafts[draftIndex], allergen };
                      if (!allergen.trim()) return;
                      persist([...rows, nextDraft]);
                      setDrafts((prev) => prev.filter((_, idx) => idx !== draftIndex));
                      return;
                    }
                    const next = rows.map((item, idx) =>
                      idx === i ? { ...item, allergen } : item
                    );
                    persist(next);
                  }}
                />
                <InlineField
                  value={row.reaction}
                  placeholder="Reaction"
                  disabled={!canEdit}
                  onCommit={(reaction) => {
                    if (isDraft) {
                      setDrafts((prev) =>
                        prev.map((item, idx) =>
                          idx === draftIndex ? { ...item, reaction } : item
                        )
                      );
                      return;
                    }
                    persist(
                      rows.map((item, idx) =>
                        idx === i ? { ...item, reaction } : item
                      )
                    );
                  }}
                />
                <InlineSelect
                  value={row.severity}
                  options={ALLERGY_SEVERITIES}
                  disabled={!canEdit}
                  onCommit={(severity) => {
                    if (isDraft) {
                      setDrafts((prev) =>
                        prev.map((item, idx) =>
                          idx === draftIndex ? { ...item, severity } : item
                        )
                      );
                      return;
                    }
                    persist(
                      rows.map((item, idx) =>
                        idx === i ? { ...item, severity } : item
                      )
                    );
                  }}
                />
                <DeleteRowButton
                  disabled={!canEdit}
                  onClick={() => {
                    if (isDraft) {
                      setDrafts((prev) => prev.filter((_, idx) => idx !== draftIndex));
                      return;
                    }
                    persist(rows.filter((_, idx) => idx !== i));
                  }}
                />
              </div>
            );
          })
        )}
      </div>
      <AddRowButton
        label="+ Add allergy"
        disabled={!canEdit}
        onClick={() =>
          setDrafts((prev) => [
            ...prev,
            { allergen: "", reaction: "", severity: "Mild" },
          ])
        }
      />
    </div>
  );
}

export function EditableMedicationTable({
  medications,
  canEdit,
  onSave,
}: {
  medications: DemoMedication[];
  canEdit: boolean;
  onSave: (next: DemoMedication[]) => void;
}) {
  const [drafts, setDrafts] = React.useState<DemoMedication[]>([]);
  const allRows = [...medications, ...drafts];

  const persist = (next: DemoMedication[]) => {
    onSave(next.filter((row) => row.name.trim()));
  };

  return (
    <div>
      <div className="rounded-xl border border-border">
        <div className="grid grid-cols-[1.6fr_1.2fr_1fr_1.5rem] border-b border-border bg-muted px-2 py-1 text-[11px] font-semibold text-foreground">
          <span>Medication</span>
          <span>Dose / Frequency</span>
          <span>Status</span>
          <span />
        </div>
        {allRows.length === 0 ? (
          <p className="px-2 py-2 text-xs text-muted-foreground">None listed</p>
        ) : (
          allRows.map((row, i) => {
            const isDraft = i >= medications.length;
            const draftIndex = i - medications.length;
            return (
              <div
                key={`med-${i}-${row.name}`}
                className="group relative grid grid-cols-[1.6fr_1.2fr_1fr_1.5rem] border-b border-border px-2 py-1.5 text-sm last:border-b-0"
              >
                <InlineField
                  value={row.name}
                  placeholder="Medication"
                  disabled={!canEdit}
                  className="font-medium"
                  onCommit={(name) => {
                    if (isDraft) {
                      const nextDraft = { ...drafts[draftIndex], name };
                      if (!name.trim()) return;
                      persist([...medications, nextDraft]);
                      setDrafts((prev) => prev.filter((_, idx) => idx !== draftIndex));
                      return;
                    }
                    persist(
                      medications.map((item, idx) =>
                        idx === i ? { ...item, name } : item
                      )
                    );
                  }}
                />
                <InlineField
                  value={row.sig}
                  placeholder="Dose / frequency"
                  disabled={!canEdit}
                  onCommit={(sig) => {
                    if (isDraft) {
                      setDrafts((prev) =>
                        prev.map((item, idx) =>
                          idx === draftIndex ? { ...item, sig } : item
                        )
                      );
                      return;
                    }
                    persist(
                      medications.map((item, idx) =>
                        idx === i ? { ...item, sig } : item
                      )
                    );
                  }}
                />
                <InlineSelect
                  value={row.status || "Active"}
                  options={MEDICATION_STATUSES}
                  disabled={!canEdit}
                  onCommit={(status) => {
                    if (isDraft) {
                      setDrafts((prev) =>
                        prev.map((item, idx) =>
                          idx === draftIndex ? { ...item, status } : item
                        )
                      );
                      return;
                    }
                    persist(
                      medications.map((item, idx) =>
                        idx === i ? { ...item, status } : item
                      )
                    );
                  }}
                />
                <DeleteRowButton
                  disabled={!canEdit}
                  onClick={() => {
                    if (isDraft) {
                      setDrafts((prev) => prev.filter((_, idx) => idx !== draftIndex));
                      return;
                    }
                    persist(medications.filter((_, idx) => idx !== i));
                  }}
                />
              </div>
            );
          })
        )}
      </div>
      <AddRowButton
        label="+ Add medication"
        disabled={!canEdit}
        onClick={() =>
          setDrafts((prev) => [
            ...prev,
            { name: "", sig: "", status: "Active" },
          ])
        }
      />
    </div>
  );
}

export function EditableProblemTable({
  problems,
  canEdit,
  onSave,
}: {
  problems: PatientProblem[];
  canEdit: boolean;
  onSave: (next: PatientProblem[]) => void;
}) {
  const [drafts, setDrafts] = React.useState<PatientProblem[]>([]);
  const allRows = [...problems, ...drafts];

  const persist = (next: PatientProblem[]) => {
    onSave(next.filter((row) => row.name.trim()));
  };

  const sinceToInput = (since: string | undefined) =>
    /^\d{4}-\d{2}-\d{2}/.test(since ?? "") ? (since ?? "").slice(0, 10) : "";

  return (
    <div>
      <div className="rounded-xl border border-border">
        <div className="grid grid-cols-[2fr_1fr_1fr_1.5rem] border-b border-border bg-muted px-2 py-1 text-[11px] font-semibold text-foreground">
          <span>Problem</span>
          <span>Status</span>
          <span>Since</span>
          <span />
        </div>
        {allRows.length === 0 ? (
          <p className="px-2 py-2 text-xs text-muted-foreground">None listed</p>
        ) : (
          allRows.map((row, i) => {
            const isDraft = i >= problems.length;
            const draftIndex = i - problems.length;
            const sinceValue = sinceToInput(row.since);
            return (
              <div
                key={`prob-${i}-${row.name}`}
                className="group relative grid grid-cols-[2fr_1fr_1fr_1.5rem] border-b border-border px-2 py-1.5 text-sm last:border-b-0"
              >
                <InlineField
                  value={row.name}
                  placeholder="Problem"
                  disabled={!canEdit}
                  className="font-medium"
                  onCommit={(name) => {
                    if (isDraft) {
                      const nextDraft = { ...drafts[draftIndex], name };
                      if (!name.trim()) return;
                      persist([...problems, nextDraft]);
                      setDrafts((prev) => prev.filter((_, idx) => idx !== draftIndex));
                      return;
                    }
                    persist(
                      problems.map((item, idx) =>
                        idx === i ? { ...item, name } : item
                      )
                    );
                  }}
                />
                <div className="flex flex-wrap items-center gap-1">
                  <InlineSelect
                    value={row.status}
                    options={PROBLEM_STATUSES}
                    disabled={!canEdit}
                    onCommit={(status) => {
                      if (isDraft) {
                        setDrafts((prev) =>
                          prev.map((item, idx) =>
                            idx === draftIndex ? { ...item, status } : item
                          )
                        );
                        return;
                      }
                      persist(
                        problems.map((item, idx) =>
                          idx === i ? { ...item, status } : item
                        )
                      );
                    }}
                  />
                  <Badge
                    variant={
                      row.status === "Resolved"
                        ? "notes"
                        : row.status === "Monitoring"
                          ? "problems"
                          : row.status === "Pending"
                            ? "allergies"
                            : row.status === "Ruled out"
                              ? "outline"
                              : "medications"
                    }
                    className="w-fit text-[10px]"
                  >
                    {row.status}
                  </Badge>
                </div>
                <InlineField
                  value={sinceValue}
                  displayValue={row.since || "Chart"}
                  type="date"
                  placeholder="Date"
                  disabled={!canEdit}
                  onCommit={(since) => {
                    const nextSince = since || "Chart";
                    if (isDraft) {
                      setDrafts((prev) =>
                        prev.map((item, idx) =>
                          idx === draftIndex ? { ...item, since: nextSince } : item
                        )
                      );
                      return;
                    }
                    persist(
                      problems.map((item, idx) =>
                        idx === i ? { ...item, since: nextSince } : item
                      )
                    );
                  }}
                />
                <DeleteRowButton
                  disabled={!canEdit}
                  onClick={() => {
                    if (isDraft) {
                      setDrafts((prev) => prev.filter((_, idx) => idx !== draftIndex));
                      return;
                    }
                    persist(problems.filter((_, idx) => idx !== i));
                  }}
                />
              </div>
            );
          })
        )}
      </div>
      <AddRowButton
        label="+ Add problem"
        disabled={!canEdit}
        onClick={() =>
          setDrafts((prev) => [
            ...prev,
            { name: "", status: "Active", since: new Date().toISOString().slice(0, 10) },
          ])
        }
      />
    </div>
  );
}

export function EditableNoteList({
  notes,
  canEdit,
  onSave,
  addLabel = "+ Add note",
  noteProvider = "Chart",
}: {
  notes: ChartNote[];
  canEdit: boolean;
  onSave: (next: ChartNote[]) => void;
  addLabel?: string;
  noteProvider?: string;
}) {
  const [draft, setDraft] = React.useState<string | null>(null);

  return (
    <div>
      <div className="space-y-1.5">
        {notes.length === 0 && draft === null ? (
          <p className="text-xs text-muted-foreground">No recent notes</p>
        ) : (
          notes.map((note, i) => (
            <div
              key={`${note.timestamp}-${i}`}
              className="group relative rounded-lg bg-muted px-2 py-1.5 pr-7 text-xs text-foreground"
            >
              <InlineField
                value={note.text}
                disabled={!canEdit}
                onCommit={(text) => {
                  if (!text.trim()) {
                    onSave(notes.filter((_, idx) => idx !== i));
                    return;
                  }
                  onSave(
                    notes.map((item, idx) =>
                      idx === i ? { ...item, text } : item
                    )
                  );
                }}
              />
              <p className="mt-0.5 text-[10px] text-muted-foreground">
                {note.provider}
                {note.timestamp
                  ? ` · ${new Date(note.timestamp).toLocaleString([], {
                      month: "short",
                      day: "numeric",
                      hour: "2-digit",
                      minute: "2-digit",
                    })}`
                  : ""}
              </p>
              <DeleteRowButton
                disabled={!canEdit}
                onClick={() => onSave(notes.filter((_, idx) => idx !== i))}
              />
            </div>
          ))
        )}
        {draft !== null && (
          <textarea
            autoFocus
            value={draft}
            placeholder="New note"
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => {
              const text = draft.trim();
              setDraft(null);
              if (!text) return;
              onSave([
                ...notes,
                {
                  text,
                  timestamp: new Date().toISOString(),
                  provider: noteProvider,
                },
              ]);
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape") setDraft(null);
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                (e.target as HTMLTextAreaElement).blur();
              }
            }}
            className={cn(INPUT_CLASS, "min-h-[56px] resize-y py-1.5")}
          />
        )}
      </div>
      <AddRowButton
        label={addLabel}
        disabled={!canEdit || draft !== null}
        onClick={() => setDraft("")}
      />
    </div>
  );
}

export function EditableStringList({
  items,
  canEdit,
  onSave,
  addLabel,
  placeholder = "New item",
  emptyLabel = "None listed",
}: {
  items: string[];
  canEdit: boolean;
  onSave: (next: string[]) => void;
  addLabel: string;
  placeholder?: string;
  emptyLabel?: string;
}) {
  const [drafts, setDrafts] = React.useState<string[]>([]);
  const allRows = [...items, ...drafts];

  return (
    <div>
      <div className="space-y-1">
        {allRows.length === 0 ? (
          <p className="text-xs text-muted-foreground">{emptyLabel}</p>
        ) : (
          allRows.map((item, i) => {
            const isDraft = i >= items.length;
            const draftIndex = i - items.length;
            return (
              <div
                key={`list-${i}-${item}`}
                className="group relative rounded-md pr-7"
              >
                <InlineField
                  value={item}
                  placeholder={placeholder}
                  disabled={!canEdit}
                  onCommit={(next) => {
                    if (isDraft) {
                      if (!next.trim()) return;
                      onSave([...items, next]);
                      setDrafts((prev) => prev.filter((_, idx) => idx !== draftIndex));
                      return;
                    }
                    if (!next.trim()) {
                      onSave(items.filter((_, idx) => idx !== i));
                      return;
                    }
                    onSave(items.map((value, idx) => (idx === i ? next : value)));
                  }}
                />
                <DeleteRowButton
                  disabled={!canEdit}
                  onClick={() => {
                    if (isDraft) {
                      setDrafts((prev) => prev.filter((_, idx) => idx !== draftIndex));
                      return;
                    }
                    onSave(items.filter((_, idx) => idx !== i));
                  }}
                />
              </div>
            );
          })
        )}
      </div>
      <AddRowButton
        label={addLabel}
        disabled={!canEdit}
        onClick={() => setDrafts((prev) => [...prev, ""])}
      />
    </div>
  );
}
