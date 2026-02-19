import json


def test_tool_args_parsing_string_json():
    args_raw = json.dumps({"a": 1})
    parsed = json.loads(args_raw)
    assert parsed["a"] == 1
