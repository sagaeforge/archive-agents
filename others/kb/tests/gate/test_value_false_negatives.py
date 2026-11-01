"""4단계 값·부정 검사의 오탐 수정(실행 A~D의 실제 항목). 고친 경우마다 통과 시험과 진짜 불일치가 걸리는 시험을 둔다.
고치지 않기로 한 경우는 그대로 걸리는 것을 고정한다."""
import pytest

from kb.gate.values import concepts, value_issues

AD = "YouTube 건너뛸 수 없는 인스트림 광고"


# ---- 고친 경우: 오탐이 풀린다
@pytest.mark.parametrize("st, q, forms", [
    ("Google Trends RSS에서 쇼트트랙의 대략적인 검색량은 500 이상으로 표시됐다.",
     "<title>쇼트트랙</title>\n\t\t\t<ht:approx_traffic>500+</ht:approx_traffic>", ()),
    ("Google Trends 자료에서 ‘bangladesh vs india’의 대략적인 검색량은 500회 이상이다.",
     "<title>bangladesh vs india</title>\n\t\t\t<ht:approx_traffic>500+</ht:approx_traffic>", ()),
    ("‘인천광역시 부교육감’의 대략적 검색량은 200 이상으로 표시됐다.",
     "<title>인천광역시 부교육감</title>\n\n<ht:approx_traffic>200+</ht:approx_traffic>", ()),
    ("온라인동영상서비스(OTT) 이용률은 2024년 79.2%에서 2025년 81.8%로 증가했다.",
     "OTT 이용률은 81.8%로 지속적으로 증가(’24년 79.2% → ’25년 \xa081.8%)", ()),
    ("40대의 온라인동영상서비스(OTT) 이용률은 2024년 90.7%에서 2025년 98.0%로 증가했다.",
     "40대의 이용률 증가가 두드러짐\n   (’23년 88.5% → ’24년 90.7% → ’25년 \xa098.0%)", ()),
    ("The Gauge의 2026년 8월 측정 구간은 2026년 7월 27일부터 2026년 8월 30일까지 5주였다.",
     "The August 2026 interval spanned five weeks, from 07/27/2026 through 08/30/2026.", ()),
    ("YouTube는 2026년 8월 24일부터 Shorts, 장편 동영상(VOD), 실시간 스트림에서 동영상 재생이 시작되는 순간 조회수를 집계한다.",
     "Beginning August 24, 2026, views are counted the moment a video starts to play across all formats, "
     "including Shorts, long-form videos (VOD), and live streams.", ()),
    ("YouTube Partner Program의 자격 기준 중 하나는 구독자 1,000명과 최근 12개월간 유효 시청 시간 4,000시간이다.",
     "Get 1,000 subscribers with 4,000 qualified watch hours in the last 12 months", ()),
    ("유효 공개 시청 시간 4,000시간 기준에는 Shorts 피드의 Shorts 조회로 발생한 시청 시간이 포함되지 않는다.",
     "Keep in mind that any qualified watch hours from Shorts views in the Shorts Feed won’t count towards "
     "the 4,000 qualified public watch hours threshold.", ()),
    ("스트리밍의 TV 이용 점유율은 전월보다 0.6%포인트 상승했다.", "the category gained 0.6 share points over July.", ()),
    (f"{AD}의 길이는 60초 이하이다.", "Non-skippable in-stream ads are 60 seconds or shorter", ()),
    (f"{AD}는 다른 동영상의 재생 전, 도중 또는 후에 재생된다.",
     "Non-skippable in-stream ads are 60 seconds or shorter, and play before, during, or after other videos.", ()),
    (f"{AD}는 YouTube 동영상에 표시된다.", "Non-skippable in-stream ads appear on YouTube videos", ()),
    ("Metal 백엔드는 fa-vec 튜닝 테이블의 키로 SKU 대신 제품군을 사용한다.",
     "metal : key the fa-vec tuned table by family instead of SKU (llama/29075)", ()),
])
def test_false_negative_passes(st, q, forms):
    assert value_issues(st, q, forms) == []


# ---- 같은 규칙에서 진짜 불일치는 그대로 걸린다
@pytest.mark.parametrize("st, q, forms, want", [
    # 리뷰가 낸 입력
    ("위원회는 피해 보상을 승인했다.", "decided not to approve compensation.", (), "neg"),                                  # 피해는 명사다. 극성 뒤집힘
    ("매일 2시간 시청한다.", "2 billion watch hours", (), "concept:hour"),
    ("Galaxy S24 이상을 지원한다.", "S24+", (), "concept:ge"),
    ("Python 3 이상을 지원한다.", "Requires Python 3+", (), "concept:ge"),
    (f"YouTube 구매할 수 없는 인스트림 광고는 표시된다.", "Non-skippable in-stream ads appear on YouTube videos", (), "neg"),
    ("측정은 5단계까지 진행된다.", "walk through 5 steps", (), "concept:before"),
    ("이 회사는 2030년에 설립됐다.", "’30년 전통의 회사", (), "num:2030"),
    ("이 회사는 2030년에 설립됐다.", "'30년 전통의 회사", (), "num:2030"),
    # 문장에 부정이 없고 인용구에 부정이 있으면 걸린다
    ("RPC 백엔드는 스핀 대기를 피하기 위해 RDMA 완료 채널을 사용한다.", "RPC: use RDMA completion channel to not spin (llama/29440)", (), "neg"),
    (f"{AD}는 표시된다.", "Non-skippable in-stream ads are not shown", (), "neg"),                                          # 이름의 부정을 지우면 not만 남는다
    ("건너뛸 수 있는 인스트림 광고는 표시된다.", "Non-skippable in-stream ads appear on YouTube videos", (), "neg"),                   # 극성 뒤집힘
    # 이전 검토의 불일치
    ("광고는 YouTube 동영상에 표시된다.", "Non-skippable in-stream ads appear on YouTube videos", (), "neg"),                       # 인용구의 이름을 문장이 뺐다
    ("검색량은 500 이상으로 표시됐다.", "<ht:approx_traffic>500</ht:approx_traffic>", (), "concept:ge"),
    ("검색량은 500 이상이다.", "5+3 equals 500", (), "concept:ge"),
    ("검색량은 500 이상이다.", "reached 500+ users", (), "concept:ge"),                                                  # approx_traffic 밖의 +
    ("OTT 이용률은 2023년 79.2%였다.", "OTT 이용률(’24년 79.2% → ’25년 81.8%)", (), "num:2023"),
    ("이용률은 2024년 79.2%였다.", "경력 24년 79.2%", (), "num:2024"),
    ("이용률은 2024년 19.8%였다.", "(24년) 음악 감상 19.8%", (), "num:2024"),
    ("이용률은 2099년 79.2%였다.", "(’99년 79.2%)", (), "num:2099"),
    ("이용률은 2030년 79.2%였다.", "(’30년 79.2%)", (), "num:2030"),                                                     # 00~29만
    ("이용률은 2024개 79.2%였다.", "(’24년 79.2%)", (), "pair:2024개"),
    ("측정 구간은 2026년 8월 30일까지였다.", "The interval started from 08/30/2026.", (), "concept:before"),
    ("측정은 3단계까지 진행된다.", "We walk through the steps of 3 stages", (), "concept:before"),
    ("2026년 8월 24일부터 조회수를 집계한다.", "August 24, 2026 was the day views were counted.", (), "concept:after"),
    ("2026년부터 집계한다.", "At the beginning of 2026 views were counted", (), "concept:after"),
    ("3단계부터 집계한다.", "beginning 3 stages ago", (), "concept:after"),                                                 # 날짜가 아니다
    ("시청 시간 4,000시간이 필요하다.", "Get 4,000 subscribers in 12 months", (), "concept:hour"),
    ("시청 시간 4,000시간이 필요하다.", "4,000 subscribers each with many long and varied watch hours", (), "concept:hour"),
    ("시청 시간은 5분이다.", "5 qualified watch hours", (), "concept:min"),
    ("점유율은 0.6% 상승했다.", "the category gained 0.6 share points over July.", (), "concept:pct"),
    ("점유율은 0.6%포인트 상승했다.", "the category gained 0.6 points over July.", (), "concept:pct"),
    ("길이는 60초 이하이다.", "ads are 60 seconds long", (), "concept:le"),
    ("길이는 60초 이하이다.", "videos are shorter or shorter", (), "concept:le"),
    (f"{AD}는 YouTube 동영상에 표시되지 않는다.", "Non-skippable in-stream ads appear on YouTube videos", (), "neg"),
    (f"{AD}는 변경할 수 없는 설정을 쓴다.", "Non-skippable in-stream ads use a setting", (), "neg"),
    (f"{AD}는 YouTube 동영상에 표시된다.", "Skippable in-stream ads appear on YouTube videos", (), "neg"),
    (f"{AD}는 YouTube 동영상에 표시된다.", "ads appear on YouTube videos", (), "neg"),
    (f"{AD}는 Google 동영상 파트너의 웹사이트와 앱에 표시된다.", "across websites and apps running on Google video partners.", (), "neg"),   # 인용구에 이름이 없다
    (f"{AD}는 YouTube Playables의 적격 모바일 게임 중단 구간에 표시된다.", "across eligible mobile gaming breaks on YouTube Playables", (), "neg"),
    ("Metal 백엔드는 제품군 대신 SKU를 사용한다.", "key the table by family instead of SKU (llama/29075)", (), "neg"),
    ("Metal 백엔드는 SKU를 사용한다.", "key the table by family instead of SKU (llama/29075)", (), "neg"),
    ("SKU 대신 제품군을 키로 쓴다.", "family is used instead of SKU and it does not fall back", (), "neg"),
    ("스핀 대기를 피한다.", "RDMA completion channel does not spin", (), "neg"),
])
def test_real_mismatch_still_fires(st, q, forms, want):
    assert any(want in w for w in value_issues(st, q, forms)), value_issues(st, q, forms)


# ---- 고치지 않기로 한 경우: 그대로 걸린다
@pytest.mark.parametrize("st, q, forms, want", [
    ("SuperClaude-Org/superclaude-plugin-marketplace는 개발 중이다.", "**Status**: In development. No ETA has been set.", (), "neg"),   # 인용구의 진짜 부정. 인용구가 넓다
    ("YouTube Partner Program 가입 요건에는 활성 AdSense for YouTube 계정을 보유하거나 YouTube Studio에서 계정을 만들 준비가 되어 있는 것이 포함된다.",
     "Have one active AdSense for YouTube account linked to your channel, or be ready to set one up in YouTube Studio if you don’t already have one",
     (), "neg"),                                                                                                   # 조건절의 부정을 뺀 문장
    ("강제 선택 방식 페르소나 분류의 인간 정답 기준 macro-F1은 약 0.50이다.",
     "models agree on personas for the 39% of comments native speakers judge to express none, keeping macro-F1 against human gold near 0.50.",
     (), "neg"),                                                                                                   # 인용구가 넓다
    ("Lim Young Woong - Baila의 Kworb 한국 트렌딩 차트 진입 기간은 6주다.", "| 44 | -10 | Lim Young Woong - Baila | 6 | 24 |  | 751,329 | -118,545 |",
     (), "concept:week"),                                                                                          # 표 열 이름은 인용구 밖이다. 6이 어느 열인지 정규식이 모른다
    ("최근 1주 VoD 이용자의 유료방송 VoD 유료 이용률은 9.7%로, 전년 8.4%보다 증가했다.",
     "유료방송 VoD를 유료로 이용한 비율도 9.7%로, 전년(8.4%) 대비 증가한 \n것으로 나타남", (), "num:1"),                            # 모델 오류: 인용구에 없는 값
    ("DataReportal 우루과이 디지털 현황 보고서는 2025년 11월 8일 발행됐다.",
     "DigitalSimon Kemp8 November 2025Digital, Digital 2026, Local, Uruguay, Southern America, AmericasComment", (), "concept:day"),   # 붙은 글자는 자료 문제다
])
def test_rejected_cases_still_fire(st, q, forms, want):
    assert any(want in w for w in value_issues(st, q, forms)), value_issues(st, q, forms)


def test_new_patterns_do_not_widen_unrelated_concepts():
    assert "ge" not in concepts("C++ 3.0") and "ge" not in concepts("500+") and "ge" in concepts("<ht:approx_traffic>500+</ht:approx_traffic>")
    assert "before" not in concepts("through the door") and "before" not in concepts("through 5 steps")
    assert "before" in concepts("through August 30") and "before" in concepts("through 08/30/2026") and "before" in concepts("through May 6")
    assert "after" in concepts("Beginning August 24, 2026") and "after" not in concepts("the beginning") and "after" not in concepts("beginning 3 stages")
    assert "hour" in concepts("4,000 qualified public watch hours") and "hour" not in concepts("watch hours")
    assert "hour" not in concepts("2 billion watch hours")
    assert "le" in concepts("60 seconds or shorter") and "le" not in concepts("shorter or shorter")
