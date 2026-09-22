import pytest

from core.converter import PageRangeError, parse_page_range


def test_empty_range_returns_all_pages():
    pages, skipped = parse_page_range("", 5)
    assert pages == [0, 1, 2, 3, 4]
    assert skipped == []


def test_mixed_range():
    pages, skipped = parse_page_range("1-3,5", 10)
    assert pages == [0, 1, 2, 4]
    assert skipped == []


def test_out_of_range_is_skipped_not_fatal():
    pages, skipped = parse_page_range("1,8,20", 5)
    assert pages == [0]
    assert skipped == [8, 20]


def test_invalid_format_raises():
    with pytest.raises(PageRangeError):
        parse_page_range("abc", 5)


def test_reversed_range_raises():
    with pytest.raises(PageRangeError):
        parse_page_range("5-2", 10)


def test_all_out_of_range_raises():
    with pytest.raises(PageRangeError):
        parse_page_range("99", 5)
