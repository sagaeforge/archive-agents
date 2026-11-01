import json, sqlite3
c = sqlite3.connect(":memory:")
c.execute("create table t(a)"); c.execute("insert into t values(1)")
print(json.dumps({"schema_version":"0.1.0","data":c.execute("select a from t").fetchall()}))
