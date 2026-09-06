LOCK TABLE acp.attention_items,acp.attention_requests,acp.attention_item_missions,acp.attention_item_evidence,acp.attention_item_effect_previews IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM acp.attention_items) OR EXISTS(SELECT 1 FROM acp.attention_requests)
    OR EXISTS(SELECT 1 FROM acp.attention_item_missions) OR EXISTS(SELECT 1 FROM acp.attention_item_evidence) OR EXISTS(SELECT 1 FROM acp.attention_item_effect_previews) THEN
    RAISE EXCEPTION '0022 downgrade would remove retained attention history'; END IF;
END; $$;
DROP FUNCTION acp.record_attention_request(jsonb,acp.stable_id);
DROP FUNCTION acp.attention_item_disclosable(acp.attention_items);
DROP FUNCTION acp.attention_receipt(acp.attention_items,acp.attention_requests,boolean);
DROP TRIGGER attention_items_commit ON acp.attention_items;
DROP TRIGGER attention_requests_commit ON acp.attention_requests;
DROP FUNCTION acp.require_attention_commit();
DROP TRIGGER attention_items_project ON acp.attention_items;
DROP FUNCTION acp.project_attention_item();
DROP TABLE acp.attention_item_effect_previews;
DROP TABLE acp.attention_item_evidence;
DROP TABLE acp.attention_item_missions;
DROP FUNCTION acp.validate_attention_reference();
DROP TABLE acp.attention_requests;
DROP FUNCTION acp.validate_attention_request();
DROP TRIGGER attention_items_validate ON acp.attention_items;
DROP FUNCTION acp.validate_attention_item();
DROP FUNCTION acp.require_attention_references(acp.attention_items);
DROP TABLE acp.attention_items;
DROP FUNCTION acp.require_attention_authority(acp.stable_id,acp.stable_id);
DROP FUNCTION acp.validate_attention_body(jsonb);
DROP FUNCTION acp.attention_text(text,integer,boolean);
