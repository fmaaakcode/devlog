import { test, expect, describe } from "bun:test";
import {
  manifestKind, parseCargoManifest, parseCppManifest, editionBehind, checkToolchain,
} from "../src/manifest-check";

describe("manifestKind", () => {
  test("recognises Cargo.toml by basename (any path / case)", () => {
    expect(manifestKind("Cargo.toml")).toBe("cargo");
    expect(manifestKind("D:/proj/Cargo.toml")).toBe("cargo");
    expect(manifestKind("proj\\sub\\cargo.toml")).toBe("cargo");
  });
  test("recognises CMake and Makefile", () => {
    expect(manifestKind("CMakeLists.txt")).toBe("cmake");
    expect(manifestKind("proj/Makefile")).toBe("makefile");
  });
  test("non-manifest → null", () => {
    expect(manifestKind("src/main.rs")).toBeNull();
    expect(manifestKind("package.json")).toBeNull();
    expect(manifestKind("")).toBeNull();
  });
});

describe("parseCppManifest", () => {
  test("CMAKE_CXX_STANDARD → C++NN", () => {
    expect(parseCppManifest("set(CMAKE_CXX_STANDARD 20)")).toEqual({ edition: "C++20", version: null });
  });
  test("Makefile -std flag (kept as written)", () => {
    expect(parseCppManifest("CXXFLAGS = -std=c++17 -O2")).toEqual({ edition: "c++17", version: null });
    expect(parseCppManifest("-std=gnu++20")).toEqual({ edition: "gnu++20", version: null });
  });
  test("no standard → null", () => {
    expect(parseCppManifest("add_executable(app main.cpp)")).toEqual({ edition: null, version: null });
  });
  test("an old C++ standard is behind the C++23 target", () => {
    const v = checkToolchain(parseCppManifest("set(CMAKE_CXX_STANDARD 17)"), { latestEdition: "C++23" });
    expect(v).toEqual([{ field: "edition", found: "C++17", target: "C++23" }]);
  });
});

describe("parseCargoManifest", () => {
  test("extracts edition and rust-version", () => {
    const s = parseCargoManifest(`[package]\nname = "x"\nedition = "2021"\nrust-version = "1.84"\n`);
    expect(s).toEqual({ edition: "2021", version: "1.84" });
  });
  test("absent fields → null (only checks what is written)", () => {
    expect(parseCargoManifest(`[package]\nname = "x"\n`)).toEqual({ edition: null, version: null });
  });
});

describe("editionBehind", () => {
  test("older edition is behind", () => {
    expect(editionBehind("2021", "2024")).toBe(true);
    expect(editionBehind("2015", "2024")).toBe(true);
  });
  test("same or newer is not behind", () => {
    expect(editionBehind("2024", "2024")).toBe(false);
    expect(editionBehind("2027", "2024")).toBe(false);
  });
  test("C++ standard labels compare too", () => {
    expect(editionBehind("C++20", "C++23")).toBe(true);
    expect(editionBehind("C++23", "C++23")).toBe(false);
  });
  test("unknown either side → not behind (never block on uncomparable)", () => {
    expect(editionBehind("", "2024")).toBe(false);
    expect(editionBehind("2021", "")).toBe(false);
  });
});

describe("checkToolchain", () => {
  const target = { latestEdition: "2024" };

  test("flags an old edition; rust-version (MSRV) is never a violation, however far behind (#1112)", () => {
    // firewall/mshfr live shape: rust-version = "1.95" with the toolchain pinned
    // in rust-toolchain.toml — raising the MSRV to the newest stable would break
    // the build ("package requires rustc 1.98 or newer").
    const v = checkToolchain({ edition: "2021", version: "1.84" }, target);
    expect(v).toEqual([{ field: "edition", found: "2021", target: "2024" }]);
  });

  test("compliant manifest → no violations", () => {
    expect(checkToolchain({ edition: "2024", version: "1.96.0" }, target)).toEqual([]);
  });

  test("absent fields are not violations", () => {
    expect(checkToolchain({ edition: null, version: null }, target)).toEqual([]);
  });

  test("no edition target (no edition concept) → nothing to judge", () => {
    expect(checkToolchain({ edition: "2021", version: "1.84" }, { latestEdition: null })).toEqual([]);
  });

  test("edition check with a null MSRV", () => {
    const v = checkToolchain({ edition: "2018", version: null }, { latestEdition: "2024" });
    expect(v).toEqual([{ field: "edition", found: "2018", target: "2024" }]);
  });
});
