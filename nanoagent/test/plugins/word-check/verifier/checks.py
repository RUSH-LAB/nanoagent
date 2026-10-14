"""Checks shared by the tool verifiers. Pure functions of their arguments."""


def result(valid, message, *, score=None, **details):
    return {
        "valid": valid,
        "score": float(valid) if score is None else score,
        "message": message,
        "details": details,
    }


def words_problem(text, words):
    """What is wrong with ``words`` as the words read from ``text``, or None."""
    if [word.text for word in words] != text.split():
        return "the words are not the text's, in order"
    for word in words:
        if (word.error is None) != word.text.isalpha():
            return f"word {word.text!r} has an error exactly when it is not all letters, and this one does not"
    return None
