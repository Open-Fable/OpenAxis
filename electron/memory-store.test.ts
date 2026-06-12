import { describe, it, expect } from "vitest";
import {
  getAdvancedSimilarity,
  getJaccardSimilarity,
  shouldKeepFact,
} from "./memory-store.js";

describe("memory-store — pure functions", () => {
  describe("getAdvancedSimilarity", () => {
    it("returns 0 for empty strings", () => {
      expect(getAdvancedSimilarity("", "test")).toBe(0);
      expect(getAdvancedSimilarity("test", "")).toBe(0);
      expect(getAdvancedSimilarity("", "")).toBe(0);
    });

    it("returns positive score for matching words", () => {
      const score = getAdvancedSimilarity(
        "Le proxy Express utilise un Bearer token",
        "proxy Bearer token",
      );
      expect(score).toBeGreaterThan(0);
    });

    it("returns 0 for completely unrelated texts", () => {
      const score = getAdvancedSimilarity(
        "Le chat mange une souris",
        "TypeScript compilation error",
      );
      expect(score).toBe(0);
    });

    it("gives higher score for longer matching words (rarity weighting)", () => {
      const shortMatch = getAdvancedSimilarity("Le code est bon", "code");
      const longMatch = getAdvancedSimilarity("Le compilation est bonne", "compilation");
      expect(longMatch).toBeGreaterThan(shortMatch);
    });

    it("gives bonus for acronyms", () => {
      const withAcronym = getAdvancedSimilarity(
        "Le système utilise OAUTH et JWT pour la sécurité",
        "oauth jwt",
      );
      const withoutAcronym = getAdvancedSimilarity(
        "Le système utilise oauth et jwt pour la sécurité",
        "oauth jwt",
      );
      expect(withAcronym).toBeGreaterThan(withoutAcronym);
    });

    it("gives bonus for exact phrase match", () => {
      const exactMatch = getAdvancedSimilarity("proxy express", "proxy express");
      const partialMatch = getAdvancedSimilarity(
        "Le proxy express est rapide et stable",
        "proxy express",
      );
      expect(exactMatch).toBeGreaterThan(partialMatch);
    });

    it("handles accented characters", () => {
      const score = getAdvancedSimilarity(
        "Gestion des clés sécurisées",
        "cles securisees",
      );
      expect(score).toBeGreaterThan(0);
    });
  });

  describe("getJaccardSimilarity", () => {
    it("returns 0 for empty strings", () => {
      expect(getJaccardSimilarity("", "test")).toBe(0);
      expect(getJaccardSimilarity("test", "")).toBe(0);
    });

    it("returns 1 for identical texts", () => {
      expect(getJaccardSimilarity("hello world", "hello world")).toBe(1);
    });

    it("returns 0 for completely different texts", () => {
      expect(getJaccardSimilarity("alpha beta", "gamma delta")).toBe(0);
    });

    it("returns correct ratio for partial overlap", () => {
      const score = getJaccardSimilarity("the cat sat", "the dog sat");
      // words: {the, cat, sat} ∩ {the, dog, sat} = {the, sat} = 2
      // union = 4, so 2/4 = 0.5
      expect(score).toBe(0.5);
    });

    it("detects near-duplicates above 0.7 threshold", () => {
      const score = getJaccardSimilarity(
        "Le proxy utilise un Bearer token pour l'authentification",
        "Le proxy utilise un Bearer token pour l'auth",
      );
      expect(score).toBeGreaterThan(0.7);
    });
  });

  describe("shouldKeepFact", () => {
    it("rejects empty or short text", () => {
      expect(shouldKeepFact("")).toBe(false);
      expect(shouldKeepFact("too short")).toBe(false);
      expect(shouldKeepFact("a")).toBe(false);
    });

    it("rejects text ending with colon (empty headers)", () => {
      expect(shouldKeepFact("Catégorie principale:")).toBe(false);
    });

    it("rejects known generic phrases", () => {
      expect(shouldKeepFact("la visibilité du contenu est importante")).toBe(false);
      expect(shouldKeepFact("ajustement des dimensions du composant")).toBe(false);
      expect(shouldKeepFact("réduction des marges latérales")).toBe(false);
    });

    it("rejects micro-CSS styling tweaks", () => {
      expect(shouldKeepFact("bouton 32x32px arrondi")).toBe(false);
      expect(shouldKeepFact("avatar 50px avec radius 6px")).toBe(false);
      expect(shouldKeepFact("icon svg 24x24px")).toBe(false);
    });

    it("accepts valid technical facts", () => {
      expect(shouldKeepFact("Le proxy Express écoute sur le port 9999")).toBe(true);
      expect(shouldKeepFact("L'authentification utilise un Bearer token")).toBe(true);
      expect(shouldKeepFact("Les secrets sont stockés dans le Keychain macOS")).toBe(
        true,
      );
    });

    it("accepts facts with dimensions but no style words", () => {
      expect(shouldKeepFact("Le serveur supporte 5000 requêtes par seconde")).toBe(true);
    });
  });
});
