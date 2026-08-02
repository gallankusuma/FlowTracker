import json, sys
d = json.load(sys.stdin)
for k, v in d["factorAnalysis"].items():
    print(f"{k}: WR_High={v['winRateHigh']}% WR_Low={v['winRateLow']}% Lift={v['lift']}% IC={v['informationCoeff']}")
