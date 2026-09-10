#!/usr/bin/env python3
"""
Unified Skills Manager for Codex using skills.sh and local cache.
Supports:
  search <query>  - Search local curated skills and skills.sh
  install <spec>  - Install skill from local cache or skills.sh via direct codeload zip
  list            - List all installed skills in CODEX_HOME/skills
"""

from __future__ import annotations

import argparse
import io
import json
import os
import re
import shutil
import subprocess
import sys
import urllib.request
import zipfile

def _get_codex_home() -> str:
    return os.environ.get("CODEX_HOME", r"C:\Users\maksk\Desktop\vscode\codex-home")

def _get_skills_dir() -> str:
    return os.path.join(_get_codex_home(), "skills")

def _get_curated_cache_dir() -> str:
    return os.path.join(_get_codex_home(), "vendor_imports", "skills", "skills", ".curated")

def _strip_ansi(text: str) -> str:
    return re.sub(r'\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])', '', text)

def cmd_list(args: argparse.Namespace) -> int:
    skills_dir = _get_skills_dir()
    if not os.path.isdir(skills_dir):
        print("No skills directory found.")
        return 0
    installed = []
    for name in sorted(os.listdir(skills_dir)):
        if name.startswith("."):
            continue
        p = os.path.join(skills_dir, name)
        if os.path.isdir(p) and os.path.isfile(os.path.join(p, "SKILL.md")):
            installed.append(name)
    if args.json:
        print(json.dumps(installed))
    else:
        print(f"Installed skills in Codex ({len(installed)}):")
        for i, name in enumerate(installed, 1):
            print(f"{i}. {name}")
    return 0

def cmd_search(args: argparse.Namespace) -> int:
    query = args.query.lower().strip()
    results = []
    seen = set()

    # 1. Local curated cache search
    curated_dir = _get_curated_cache_dir()
    if os.path.isdir(curated_dir):
        for name in sorted(os.listdir(curated_dir)):
            if query in name.lower():
                seen.add(name)
                results.append({
                    "name": name,
                    "source": "local-curated",
                    "pkg": f"curated/{name}",
                    "installs": "pre-cached",
                    "url": "local"
                })

    # 2. Online search via skills.sh CLI (npx skills find)
    try:
        cmd = ["cmd.exe", "/c", "npx", "--yes", "skills", "find", query]
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=20, cwd=_get_codex_home())
        if proc.returncode == 0:
            lines = proc.stdout.splitlines()
            current_pkg = None
            current_installs = ""
            for line in lines:
                clean = _strip_ansi(line).strip()
                if not clean or clean.startswith("Install with"):
                    continue
                if "@" in clean and not clean.startswith("└"):
                    parts = clean.split()
                    current_pkg = parts[0]
                    current_installs = parts[1] if len(parts) > 1 else ""
                elif clean.startswith("└") and current_pkg:
                    url = clean.lstrip("└ ").strip()
                    skill_name = current_pkg.split("@")[-1]
                    if skill_name not in seen:
                        seen.add(skill_name)
                        results.append({
                            "name": skill_name,
                            "source": "skills.sh",
                            "pkg": current_pkg,
                            "installs": current_installs,
                            "url": url
                        })
                    current_pkg = None
    except Exception as e:
        sys.stderr.write(f"Warning: skills.sh search error: {e}\n")

    if args.json:
        print(json.dumps(results, indent=2))
    else:
        if not results:
            print(f"No skills found for '{query}'.")
            return 0
        print(f"Skills matching '{query}' ({len(results)} found):")
        for i, item in enumerate(results[:15], 1):
            source_tag = "[Local Cache]" if item["source"] == "local-curated" else f"[skills.sh - {item['installs']} installs]"
            print(f"{i}. {item['name']} {source_tag}")
            print(f"   Package: {item['pkg']}")
            if item["url"] != "local":
                print(f"   URL: {item['url']}")
    return 0

def cmd_install(args: argparse.Namespace) -> int:
    target = args.spec.strip()
    if "@" in target:
        repo_part, skill_name = target.split("@", 1)
    elif "/" in target:
        repo_part = target
        skill_name = target.split("/")[-1]
    else:
        repo_part = ""
        skill_name = target

    skills_dir = _get_skills_dir()
    dest_path = os.path.join(skills_dir, skill_name)
    curated_dir = _get_curated_cache_dir()
    local_path = os.path.join(curated_dir, skill_name)

    # 1. Local curated install
    if os.path.isdir(local_path):
        print(f"Installing '{skill_name}' from local curated cache...")
        if os.path.exists(dest_path):
            shutil.rmtree(dest_path)
        shutil.copytree(local_path, dest_path)
        skill_md = os.path.join(dest_path, "SKILL.md")
        print(f"SUCCESS: Skill '{skill_name}' installed into {dest_path}")
        print(f"SKILL_FILE: {skill_md}")
        print("ACTION: Read the SKILL.md file immediately to follow its instructions.")
        return 0

    # 2. Remote install from skills.sh / GitHub
    if not repo_part:
        print(f"Searching skills.sh for package providing '{skill_name}'...")
        try:
            cmd = ["cmd.exe", "/c", "npx", "--yes", "skills", "find", skill_name]
            proc = subprocess.run(cmd, capture_output=True, text=True, timeout=20, cwd=_get_codex_home())
            for line in proc.stdout.splitlines():
                clean = _strip_ansi(line).strip()
                if f"@{skill_name}" in clean or clean.endswith(skill_name):
                    parts = clean.split()
                    target = parts[0]
                    if "@" in target:
                        repo_part, skill_name = target.split("@", 1)
                    break
        except Exception as e:
            sys.stderr.write(f"Search fallback failed: {e}\n")

    parts = repo_part.split("/")
    if len(parts) != 2:
        print(f"ERROR: Could not resolve package for '{target}'. Use format 'owner/repo@skill'.")
        return 1

    owner, repo = parts[0], parts[1]
    print(f"Downloading '{skill_name}' from https://skills.sh/{owner}/{repo}/{skill_name} ...")

    branches = ["main", "master"]
    data = None
    for branch in branches:
        zip_url = f"https://codeload.github.com/{owner}/{repo}/zip/{branch}"
        try:
            req = urllib.request.Request(zip_url, headers={"User-Agent": "codex-skill-installer"})
            with urllib.request.urlopen(req, timeout=25) as resp:
                data = resp.read()
                break
        except Exception:
            continue

    if not data:
        print(f"ERROR: Failed to download archive for {owner}/{repo} from GitHub.")
        return 1

    try:
        zf = zipfile.ZipFile(io.BytesIO(data))
        namelist = zf.namelist()
        if not namelist:
            print("ERROR: Downloaded archive was empty.")
            return 1

        top_dir = namelist[0].split("/")[0]
        skill_root_prefix = None

        candidates = [
            f"{top_dir}/skills/{skill_name}/SKILL.md",
            f"{top_dir}/{skill_name}/SKILL.md",
            f"{top_dir}/SKILL.md"
        ]
        for cand in candidates:
            if cand in namelist:
                skill_root_prefix = cand[:-len("SKILL.md")]
                break

        if not skill_root_prefix:
            for name in namelist:
                if name.endswith("SKILL.md") and (skill_name in name or name.count("/") <= 2):
                    skill_root_prefix = name[:-len("SKILL.md")]
                    break

        if not skill_root_prefix:
            print(f"ERROR: SKILL.md not found in {owner}/{repo}.")
            return 1

        if os.path.exists(dest_path):
            shutil.rmtree(dest_path)
        os.makedirs(dest_path, exist_ok=True)

        for member in namelist:
            if member.startswith(skill_root_prefix) and not member.endswith("/"):
                rel_path = member[len(skill_root_prefix):]
                target_file = os.path.join(dest_path, rel_path.replace("/", os.sep))
                os.makedirs(os.path.dirname(target_file), exist_ok=True)
                with open(target_file, "wb") as f:
                    f.write(zf.read(member))

        skill_md = os.path.join(dest_path, "SKILL.md")
        print(f"SUCCESS: Skill '{skill_name}' installed into {dest_path}")
        print(f"SKILL_FILE: {skill_md}")
        print("ACTION: Read the SKILL.md file immediately to follow its instructions.")
        return 0
    except Exception as exc:
        print(f"ERROR: Extraction failed: {exc}")
        return 1

def main() -> int:
    parser = argparse.ArgumentParser(description="Codex Skills.sh Manager")
    subparsers = parser.add_subparsers(dest="subcommand", required=True)

    list_p = subparsers.add_parser("list", help="List installed skills")
    list_p.add_argument("--json", action="store_true", help="Output as JSON")

    search_p = subparsers.add_parser("search", help="Search skills on skills.sh & local cache")
    search_p.add_argument("query", help="Keyword to search")
    search_p.add_argument("--json", action="store_true", help="Output as JSON")

    install_p = subparsers.add_parser("install", help="Install a skill")
    install_p.add_argument("spec", help="Skill name or package (e.g. 'playwright-best-practices' or 'owner/repo@skill')")

    args = parser.parse_args()
    if args.subcommand == "list":
        return cmd_list(args)
    elif args.subcommand == "search":
        return cmd_search(args)
    elif args.subcommand == "install":
        return cmd_install(args)
    return 0

if __name__ == "__main__":
    sys.exit(main())
