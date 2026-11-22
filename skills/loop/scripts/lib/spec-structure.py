#!/usr/bin/env python3
"""Check the Markdown structure used by the loop's draft and issue body."""

from dataclasses import dataclass
import json
import re
import sys


@dataclass
class Token:
    title: str = ""
    level: int = 0
    text: str = ""
    language: str = ""
    closed: bool = False

    @property
    def is_code(self):
        return bool(self.language or self.closed)


def markdown(lines):
    fence = None
    block = None
    for line in lines:
        marker = re.match(r"^ {0,3}(`{3,}|~{3,})(.*)$", line)
        if fence:
            if marker and marker[1].startswith(fence) and not marker[2].strip():
                block.closed = True
                yield block
                fence = block = None
            else:
                block.text += line + "\n"
        elif marker:
            fence = marker[1]
            block = Token(language=marker[2].strip() or "text")
        else:
            heading = re.match(r"^ {0,3}(#{1,6})[ \t]+(.+?)\s*$", line)
            if heading:
                yield Token(title=heading[2].rstrip("#").strip(), level=len(heading[1]))
            else:
                yield Token(text=line)
    if block:
        yield block


def sections(tokens, level):
    result = {}
    for index, token in enumerate(tokens):
        if token.level != level:
            continue
        end = next((i for i in range(index + 1, len(tokens))
                    if tokens[i].level and tokens[i].level <= level), len(tokens))
        result.setdefault(token.title, []).append(tokens[index + 1:end])
    return result


def steps(tokens):
    current = []
    indent = 0
    for token in tokens:
        if token.is_code:
            continue
        if token.level or re.match(r"^\s*- \[[ xX]\](?:\s|$)", token.text):
            if current:
                yield current
            current = []
            if not token.level:
                current.append(token.text)
                indent = len(token.text) - len(token.text.lstrip())
        elif current and len(token.text) - len(token.text.lstrip()) > indent:
            current.append(token.text)
    if current:
        yield current


def prose(tokens):
    return "\n".join(t.text for t in tokens if not t.is_code and not t.level).strip()


def sequence_diagram(token):
    if not token.closed or token.language != "mermaid":
        return False
    lines = [line.strip() for line in token.text.splitlines()
             if line.strip() and not line.lstrip().startswith("%%")]
    return (len(lines) > 1 and lines[0] == "sequenceDiagram" and
            any(re.search(r"\S\s*-+[<>x)]+\s*[^:]+:\s*\S", line) for line in lines[1:]))


findings = []


def error(check, message):
    findings.append({"severity": "error", "check": check, "message": message})


def required(groups, names, check):
    result = {}
    for name in names:
        matches = groups.get(name, [])
        if len(matches) != 1:
            error(check, f"expected one {name} heading in its section")
        result[name] = matches[0] if matches else []
    return result


def check_contracts(tokens, kind):
    entries = sections(tokens, 4)
    data_models = kind == "data-models"
    if entries:
        for title, entries_with_title in entries.items():
            if len(entries_with_title) != 1:
                error(kind, f"duplicate contract heading: {title}")
            block = entries_with_title[0]
            roles = set()
            pending = ""
            for token in block:
                if token.is_code:
                    if token.closed and token.text.strip() and pending:
                        roles.add(pending)
                    pending = ""
                elif token.text.strip():
                    label = re.fullmatch(r"\*\*(Before|After)\*\*", token.text.strip())
                    pending = label[1] if label else ""
            expected = {"After"} if title.startswith("New ") else (
                {"Before"} if title.startswith("Removed ") else {"Before", "After"})
            if not expected.issubset(roles):
                error(kind, f"{title} needs the relevant Before and After code blocks")
            notes = prose(block)
            if data_models:
                if not re.match(r"^(New|Modified|Removed) ", title):
                    error(kind, f"{title} needs a New, Modified, or Removed heading")
                if not re.search(r"^- \*\*Compatibility\*\*\s+\S", notes, re.M):
                    error(kind, f"{title} needs a Compatibility note")
            else:
                if not re.search(r"^- \*\*Breaking\*\*\s+(yes|no)\b", notes, re.M | re.I):
                    error(kind, f"{title} needs a Breaking note")
                if not re.search(r"^- \*\*Consumers\*\*\s+[0-9]+(?:[ .,(]|$)", notes, re.M):
                    error(kind, f"{title} needs a numeric Consumers count")
        return
    text = prose(tokens)
    if re.fullmatch(r"No changes\.?", text, re.I):
        return
    # Existing issue bodies may use the older contract tables.
    rows = [[column.strip() for column in line[1:-1].split("|")]
            for line in text.splitlines() if line.startswith("|") and line.endswith("|")]
    header = "Entity" if data_models else "Interface"
    rows = [row for row in rows if row[0] != header and not re.fullmatch(r":?-+:?", row[0])]
    if not rows:
        error(kind, "describe the changed contracts or write No changes.")
        return
    for row in rows:
        if data_models and (len(row) < 4 or row[1].lower() not in {"new", "modified", "removed"} or not row[3]):
            error(kind, f"{row[0]} needs a change type and a compatibility note")
        elif not data_models and (len(row) < 5 or not re.match(r"[0-9]+(?:[ .,(]|$)|none(?: yet)?$", row[4], re.I)):
            error(kind, f"{row[0]} needs a numeric consumer count")


strict = "--require-plan-evidence" in sys.argv[1:]
body = list(markdown(sys.stdin.read().splitlines()))
if any(t.is_code and not t.closed for t in body):
    error("sections", "close all fenced code blocks")
top = required(sections(body, 2), ("Product spec", "Behaviour criteria", "Technical spec", "Plan"), "sections")
product = top["Product spec"]
if not prose(product):
    error("product", "Product spec is empty")
if strict:
    for name, content in required(sections(product, 3), ("Functional requirements", "Non-functional requirements"), "product").items():
        if not prose(content):
            error("product", f"{name} is empty")

technical_names = ("Architecture decision", "Data models", "Interfaces", "Folder structure", "Workflows")
technical = required(sections(top["Technical spec"], 3), technical_names, "spec-sections")
architecture = prose(technical["Architecture decision"])
if not architecture:
    error("architecture", "Architecture decision is empty")
elif strict:
    for name in ("Seam added", "Invariant and owner", "Input validation"):
        if not re.search(r"^\|\s*" + name + r"\s*\|\s*[^|\s]", architecture, re.M):
            error("architecture", f"Architecture decision needs a {name} entry")
check_contracts(technical["Data models"], "data-models")
check_contracts(technical["Interfaces"], "interfaces")
if not any(t.is_code and t.closed and re.search(r"\b(NEW|MOD|DEL)\b", t.text)
           for t in technical["Folder structure"]) and not re.search(r"\b(NEW|MOD|DEL)\b", prose(technical["Folder structure"])):
    error("folders", "show the changed paths with NEW, MOD, or DEL")
if not any(sequence_diagram(t) for t in technical["Workflows"]):
    error("workflows", "add a closed Mermaid sequenceDiagram with an interaction under Workflows")

criteria = list(steps(top["Behaviour criteria"]))
if not criteria:
    error("behaviours", "add at least one behaviour criterion")
for item, lines in enumerate(criteria, 1):
    scenario = re.sub(r"^\s*- \[[ xX]\]\s*", "", " ".join(lines))
    scenario = re.sub(r"\*\*(given|when|then)\*\*", r"\1", scenario, flags=re.I)
    if not re.match(r"^given\s+\S.*?\s+when\s+\S.*?\s+then\s+\S", scenario, re.I):
        error("behaviours", f"criterion {item} needs Given, When, and Then")

plan_titles = []
for lines in steps(top["Plan"]):
    title = re.sub(r"^\s*- \[[ xX]\]\s*", "", lines[0]).strip()
    if not title:
        error("plan", "each plan item needs a title")
    plan_titles.append(title)
    if strict:
        indent = len(lines[0]) - len(lines[0].lstrip())
        details = [line.lstrip() for line in lines[1:] if len(line) - len(line.lstrip()) > indent]
        for label in ("Verify", "Expected"):
            if not any(re.match(r"- \*\*" + label + r"\*\*\s+\S", line) for line in details):
                error("plan-evidence", f"{title} needs a {label} entry")
if not plan_titles:
    error("plan", "add at least one plan item")
print(json.dumps({"findings": findings, "planTitles": plan_titles}))
