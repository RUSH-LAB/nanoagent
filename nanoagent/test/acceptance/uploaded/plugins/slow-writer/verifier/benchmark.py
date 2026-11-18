"""The probe's benchmark hooks: answers are checked as the task is, a refusal must name the reference error."""

EXECUTION_FAILED = "execution_failed"


def verdict(passed, score, explanation=None):
    return {"verdict": "pass" if passed else "fail", "score": score, "explanation": explanation}


def verify_case(verify_task, outcome, reference, suite):
    low, high = suite["scale"]["min"], suite["scale"]["max"]
    if outcome["status"] == "answered":
        valid = verify_task(None, outcome["answer"], reference, None)["valid"]
        return verdict(valid, high if valid else low)
    if outcome["status"] == "refused":
        # A refusal case's reference is the pinned reference error; an answer case has none to name.
        valid = isinstance(reference, str) and reference in outcome["reason"]
        return verdict(valid, high if valid else low)
    return verdict(False, low, EXECUTION_FAILED)


def score_suite(suite, cases):
    weights = [suite["weights"].get(case["case_id"], 1) for case in cases]
    total = sum(weight * case["score"] for weight, case in zip(weights, cases))
    return {"score": total / sum(weights)}
