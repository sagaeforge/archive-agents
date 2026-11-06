-- gold 그래프(ADR 7.2). 원장과 CAS의 순수 함수다. gold_schema를 올리려면 ADR 22장 절차를 따른다.
CREATE TABLE node(vid INTEGER PRIMARY KEY, id TEXT NOT NULL, version INT NOT NULL, type TEXT NOT NULL,
  origin TEXT NOT NULL, status TEXT NOT NULL, eff_status TEXT NOT NULL, liveness TEXT, link_status TEXT, verification TEXT,
  sensitivity INT NOT NULL, retention TEXT NOT NULL, label TEXT NOT NULL, content_sha TEXT, body_format TEXT, lang TEXT,
  props BLOB, author TEXT, generated_by TEXT, on_behalf_of TEXT, merged_into TEXT,
  valid_from INT, valid_to INT, valid_precision TEXT, recorded_at INT NOT NULL, expired_at INT,
  seq INT NOT NULL, UNIQUE(id, version));
CREATE INDEX node_label ON node(label COLLATE NOCASE) WHERE expired_at IS NULL;
CREATE TABLE edge(vid INTEGER PRIMARY KEY, id TEXT NOT NULL, version INT NOT NULL, src TEXT NOT NULL,
  rtype TEXT NOT NULL, dst TEXT NOT NULL, props BLOB, claim_id TEXT, status TEXT NOT NULL, sensitivity INT NOT NULL,
  valid_from INT, valid_to INT, recorded_at INT NOT NULL, expired_at INT, seq INT NOT NULL, UNIQUE(id, version));
CREATE INDEX edge_src ON edge(src, rtype) WHERE expired_at IS NULL;
CREATE INDEX edge_dst ON edge(dst, rtype) WHERE expired_at IS NULL;
CREATE INDEX edge_claim ON edge(claim_id);
CREATE INDEX edge_promotion ON edge(dst, src) WHERE rtype='PROMOTED_FROM';
CREATE TABLE claim(vid INTEGER PRIMARY KEY REFERENCES node(vid), subject TEXT NOT NULL, predicate TEXT, object TEXT,
  value TEXT, unit TEXT, qualifiers BLOB, statement TEXT NOT NULL, kind TEXT NOT NULL, stance TEXT NOT NULL,
  speaker TEXT, method TEXT NOT NULL, slot TEXT, conflict_group TEXT, change_claim TEXT, extractor TEXT);
CREATE INDEX claim_subject ON claim(subject);
CREATE TABLE evidence(id TEXT PRIMARY KEY, claim_id TEXT NOT NULL, snapshot_id TEXT NOT NULL, text_sha TEXT,
  selector_kind TEXT NOT NULL, exact TEXT, prefix TEXT, suffix TEXT, start_cp INT, end_cp INT, json_pointer TEXT,
  evidence_state TEXT NOT NULL DEFAULT 'live', support_check TEXT,
  gate_version TEXT NOT NULL, last_confirmed_at INT, seq INT NOT NULL);
CREATE INDEX evidence_claim ON evidence(claim_id);
CREATE INDEX evidence_snapshot ON evidence(snapshot_id, claim_id);
CREATE TABLE content(sha TEXT PRIMARY KEY, body TEXT NOT NULL) WITHOUT ROWID;
CREATE TABLE unit(rid INTEGER PRIMARY KEY, sha TEXT NOT NULL UNIQUE, kind TEXT NOT NULL);
CREATE TABLE span(sid INTEGER PRIMARY KEY, unit_rid INT NOT NULL, ref_id TEXT NOT NULL, ref_kind TEXT NOT NULL,
  subject TEXT, claim_kind TEXT, type TEXT NOT NULL, origin TEXT NOT NULL, status TEXT NOT NULL,
  eff_status TEXT NOT NULL, verification TEXT, sensitivity INT NOT NULL, start_cp INT, end_cp INT, snapshot_id TEXT, source_id TEXT,
  valid_from INT, valid_to INT, rec_from INT NOT NULL, rec_to INT);
CREATE INDEX span_facet ON span(source_id, eff_status, verification, sensitivity) WHERE rec_to IS NULL;
CREATE INDEX span_ref ON span(ref_id) WHERE rec_to IS NULL;
CREATE INDEX span_unit ON span(unit_rid);
CREATE TRIGGER node_fact_span_put AFTER INSERT ON span WHEN NEW.source_id IS NOT NULL BEGIN
  UPDATE node_fact SET src=COALESCE((SELECT s.source_id FROM span s WHERE s.ref_id=NEW.ref_id AND s.rec_to IS NULL AND s.source_id IS NOT NULL ORDER BY s.sid LIMIT 1), psrc)
  WHERE id=NEW.ref_id;
END;
CREATE TRIGGER node_fact_span_set AFTER UPDATE OF rec_to, source_id ON span BEGIN
  UPDATE node_fact SET src=COALESCE((SELECT s.source_id FROM span s WHERE s.ref_id=NEW.ref_id AND s.rec_to IS NULL AND s.source_id IS NOT NULL ORDER BY s.sid LIMIT 1), psrc)
  WHERE id=NEW.ref_id;
END;
CREATE VIRTUAL TABLE fts USING fts5(tok, content='', contentless_delete=1,
  tokenize="unicode61 remove_diacritics 0");
CREATE VIRTUAL TABLE fts_vocab USING fts5vocab(fts, 'row');
CREATE TABLE alias(norm TEXT NOT NULL, node_id TEXT NOT NULL, lang TEXT, PRIMARY KEY(norm, node_id)) WITHOUT ROWID;
CREATE TABLE node_domain(domain TEXT NOT NULL, node_id TEXT NOT NULL, PRIMARY KEY(domain, node_id)) WITHOUT ROWID;
CREATE INDEX node_domain_id ON node_domain(node_id);
-- 패싯 요약(gold_schema 3): 현재 버전이고 병합되지 않은 주장 밖 노드 한 건당 한 행. 노드, 도메인, span 쓰기의 트리거만 채운다.
-- 지문에 넣지 않는다. 원본 표의 함수이고, tests/http/test_node_fact.py가 원본 표로 다시 계산한 값과 대조한다.
CREATE TABLE node_fact(id TEXT PRIMARY KEY, type TEXT NOT NULL, origin TEXT NOT NULL, eff_status TEXT NOT NULL,
  sensitivity INT NOT NULL, src TEXT, psrc TEXT, dom TEXT) WITHOUT ROWID;
CREATE INDEX node_fact_group ON node_fact(type, origin, eff_status, src, dom, sensitivity, psrc);
CREATE TRIGGER node_fact_put AFTER INSERT ON node WHEN NEW.expired_at IS NULL BEGIN
  DELETE FROM node_fact WHERE id=NEW.id;
  INSERT INTO node_fact(id,type,origin,eff_status,sensitivity,src,psrc,dom)
  SELECT NEW.id, NEW.type, NEW.origin, NEW.eff_status, NEW.sensitivity,
    COALESCE((SELECT s.source_id FROM span s WHERE s.ref_id=NEW.id AND s.rec_to IS NULL AND s.source_id IS NOT NULL ORDER BY s.sid LIMIT 1),
             json_extract(CAST(NEW.props AS TEXT),'$.source')),
    json_extract(CAST(NEW.props AS TEXT),'$.source'),
    (SELECT group_concat(domain) FROM (SELECT d.domain FROM node_domain d WHERE d.node_id=NEW.id ORDER BY d.domain))
  WHERE NEW.merged_into IS NULL AND NEW.type<>'Claim';
END;
CREATE TRIGGER node_fact_expire AFTER UPDATE OF expired_at ON node WHEN NEW.expired_at IS NOT NULL BEGIN
  DELETE FROM node_fact WHERE id=NEW.id AND NOT EXISTS(SELECT 1 FROM node n WHERE n.id=NEW.id AND n.expired_at IS NULL);
END;
CREATE TRIGGER node_fact_domain AFTER INSERT ON node_domain BEGIN
  UPDATE node_fact SET dom=(SELECT group_concat(domain) FROM (SELECT d.domain FROM node_domain d WHERE d.node_id=NEW.node_id ORDER BY d.domain))
  WHERE id=NEW.node_id;
END;
CREATE TABLE series_obs(oid INTEGER PRIMARY KEY, series_id TEXT NOT NULL, period_key TEXT NOT NULL,
  period_start INT NOT NULL, period_end INT, value TEXT NOT NULL, unit TEXT, snapshot_id TEXT,
  observed_at INT NOT NULL, last_seen_at INT NOT NULL, expired_at INT, seq INT NOT NULL);
CREATE INDEX series_obs_cur ON series_obs(series_id, period_key) WHERE expired_at IS NULL;
CREATE TABLE gap(source_id TEXT, from_at INT, to_at INT, reason TEXT, seq INT);
CREATE TABLE change(seq INT NOT NULL, sub INT NOT NULL DEFAULT 0, at INT NOT NULL, kind TEXT NOT NULL, id TEXT, version INT,
  origin TEXT, type TEXT, sensitivity INT NOT NULL, PRIMARY KEY(seq, sub));
CREATE TABLE type_def(name TEXT, kind TEXT, version INT, schema_json TEXT, status TEXT, PRIMARY KEY(name, kind, version));
CREATE TABLE head(id TEXT PRIMARY KEY, kind TEXT NOT NULL, version INT NOT NULL, sensitivity INT NOT NULL,
  merged_into_final TEXT) WITHOUT ROWID;
CREATE TABLE quarantine(seq INTEGER PRIMARY KEY, reason TEXT NOT NULL, at INT NOT NULL);
CREATE TABLE meta(k TEXT PRIMARY KEY, v TEXT NOT NULL) WITHOUT ROWID;
-- 검증이 끝나기 전에 private 읽기 준비 완료를 선언하지 않는다.
INSERT INTO meta(k,v) VALUES('fp_projection','5'), ('private_open','false');
