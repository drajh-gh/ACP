LOCK TABLE acp.unknown_effect_attention_sources IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN IF EXISTS(SELECT 1 FROM acp.unknown_effect_attention_sources) THEN
  RAISE EXCEPTION '0023 downgrade would remove retained unknown-outcome attention sources'; END IF; END; $$;
DROP FUNCTION acp.capture_unknown_effect_attention(acp.stable_id,acp.stable_id,acp.stable_id);
DROP TABLE acp.unknown_effect_attention_sources;
DROP FUNCTION acp.validate_unknown_effect_attention_source();
DROP FUNCTION acp.unknown_effect_attention_body(acp.stable_id,acp.stable_id);
DROP FUNCTION acp.unknown_effect_attention_eligible(acp.stable_id,acp.stable_id);
