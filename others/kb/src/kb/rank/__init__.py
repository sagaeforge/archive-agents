"""kb-rank(WP-20): 벡터 파생물과 재순위. 조회는 GPU 없이도 끝까지 동작한다(R10).

코어, read, serve에는 torch를 임포트하지 않는다. 이 패키지에서 torch를 쓰는 파일은 models.py 하나이고
venv-rank에서만 불러진다. client.py는 표준 라이브러리만 쓴다.
"""
