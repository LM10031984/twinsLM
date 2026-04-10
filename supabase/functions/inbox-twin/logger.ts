import { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

export async function logDecision(
  supabase: SupabaseClient,
  params: {
    agent: string;
    action: string;
    inputSummary: string;
    outputSummary: string;
    confidence: number;
    metadata?: Record<string, unknown>;
  }
): Promise<string> {
  const { data, error } = await supabase
    .from("decisions_log")
    .insert({
      agent: params.agent,
      action: params.action,
      input_summary: params.inputSummary,
      output_summary: params.outputSummary,
      confidence: params.confidence,
      metadata: params.metadata ?? {},
    })
    .select("id")
    .single();

  if (error) console.error("decisions_log insert failed:", error);
  return data?.id ?? "";
}

export async function logCorrection(
  supabase: SupabaseClient,
  params: {
    decisionId: string;
    agent: string;
    originalDraft: string;
    correctedText: string;
    diffSummary?: string;
  }
): Promise<void> {
  const { error } = await supabase.from("corrections_log").insert({
    decision_id: params.decisionId,
    agent: params.agent,
    original_draft: params.originalDraft,
    corrected_text: params.correctedText,
    diff_summary: params.diffSummary ?? "",
    learned: false,
  });
  if (error) console.error("corrections_log insert failed:", error);
}
