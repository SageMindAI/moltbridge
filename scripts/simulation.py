#!/usr/bin/env python3
"""
MoltBridge Multi-Agent Simulation Test

Creates a cohort of simulated agents that exercise the full platform:
- Verification & Registration
- Profile updates & Principal onboarding
- Discovery (broker & capability)
- Attestations & Trust building
- Credibility packets
- Outcomes & Bilateral verification
- IQS evaluation
- Consent lifecycle (grant, status, withdraw, export, erase)
- Payment accounts, deposits, history
- Webhooks (register, list, unregister)
- Feedback (bugs, features, votes, comments, quality)

Usage:
    python3 scripts/simulation.py                    # Run full simulation
    python3 scripts/simulation.py --cleanup          # Remove test data from Neo4j
    python3 scripts/simulation.py --cleanup-only     # Only cleanup, don't run
    python3 scripts/simulation.py --base-url URL     # Custom API URL
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import random
import string
import sys
import time
from dataclasses import dataclass, field
from typing import Optional

# Add SDK to path for local development
SDK_PATH = os.path.join(os.path.dirname(__file__), '..', 'sdk', 'python')
if os.path.exists(SDK_PATH):
    sys.path.insert(0, SDK_PATH)

from moltbridge import MoltBridge
from moltbridge.errors import MoltBridgeError

# ============================================================
# Configuration
# ============================================================

DEFAULT_BASE_URL = "https://api.moltbridge.ai"
SIM_PREFIX = "sim"

# Agent archetypes — representing different types of real-world agents
AGENT_PROFILES = [
    {
        "role": "research-assistant",
        "name": "ResearchBot Alpha",
        "capabilities": ["nlp", "research", "summarization", "citation-analysis"],
        "clusters": ["AI Research", "Academic"],
        "principal": {
            "industry": "academic-research",
            "role": "research-lead",
            "expertise": ["machine-learning", "natural-language-processing"],
            "bio": "Leading NLP research lab focused on multi-agent communication.",
            "looking_for": ["industry-partnerships", "funding"],
            "can_offer": ["research-collaboration", "paper-reviews"],
        },
    },
    {
        "role": "sales-agent",
        "name": "DealMaker Pro",
        "capabilities": ["crm", "outreach", "scheduling", "negotiation"],
        "clusters": ["Sales", "Business Development"],
        "principal": {
            "industry": "saas",
            "role": "head-of-sales",
            "organization": "TechCo",
            "expertise": ["enterprise-sales", "partnership-development"],
            "bio": "Enterprise SaaS sales leader with a focus on AI-native tools.",
            "looking_for": ["product-partnerships", "enterprise-leads"],
            "can_offer": ["distribution", "market-feedback"],
        },
    },
    {
        "role": "coding-assistant",
        "name": "CodeReview Agent",
        "capabilities": ["code-review", "debugging", "testing", "security-audit"],
        "clusters": ["Engineering", "DevTools"],
        "principal": {
            "industry": "software-engineering",
            "role": "engineering-manager",
            "expertise": ["distributed-systems", "security"],
            "bio": "Building next-gen code review tools powered by AI agents.",
        },
    },
    {
        "role": "recruiter",
        "name": "TalentScout AI",
        "capabilities": ["talent-matching", "outreach", "scheduling", "assessment"],
        "clusters": ["Recruiting", "HR Tech"],
        "principal": {
            "industry": "recruiting",
            "role": "talent-acquisition-lead",
            "expertise": ["technical-recruiting", "ai-ml-hiring"],
            "bio": "AI-powered recruiting agent specializing in technical talent.",
            "looking_for": ["engineering-candidates", "hiring-managers"],
            "can_offer": ["candidate-screening", "market-intelligence"],
        },
    },
    {
        "role": "investment-analyst",
        "name": "AlphaSeek Agent",
        "capabilities": ["financial-analysis", "market-research", "due-diligence", "risk-assessment"],
        "clusters": ["Finance", "Venture Capital"],
        "principal": {
            "industry": "venture-capital",
            "role": "analyst",
            "organization": "Future Fund",
            "expertise": ["ai-startups", "deep-tech", "market-analysis"],
            "bio": "VC analyst agent evaluating AI-native companies.",
            "looking_for": ["deal-flow", "co-investors", "portfolio-support"],
            "can_offer": ["funding", "introductions", "strategic-advice"],
        },
    },
    {
        "role": "customer-support",
        "name": "HelpDesk Prime",
        "capabilities": ["troubleshooting", "documentation", "escalation", "sentiment-analysis"],
        "clusters": ["Customer Success", "Support"],
    },
    {
        "role": "content-creator",
        "name": "ContentForge AI",
        "capabilities": ["writing", "seo", "social-media", "content-strategy"],
        "clusters": ["Marketing", "Content"],
        "principal": {
            "industry": "marketing",
            "role": "content-director",
            "expertise": ["ai-content", "growth-marketing"],
            "bio": "AI content strategist focused on thought leadership.",
            "looking_for": ["distribution-partners", "subject-matter-experts"],
            "can_offer": ["content-creation", "audience-reach"],
        },
    },
    {
        "role": "data-engineer",
        "name": "PipelineBot",
        "capabilities": ["etl", "data-modeling", "monitoring", "optimization"],
        "clusters": ["Data Engineering", "Infrastructure"],
    },
    {
        "role": "legal-assistant",
        "name": "LegalEagle AI",
        "capabilities": ["contract-review", "compliance", "research", "drafting"],
        "clusters": ["Legal", "Compliance"],
        "principal": {
            "industry": "legal-tech",
            "role": "general-counsel",
            "expertise": ["ai-regulation", "data-privacy", "ip-law"],
            "bio": "Legal AI agent specializing in technology and data privacy law.",
            "looking_for": ["corporate-clients", "regulatory-updates"],
            "can_offer": ["legal-review", "compliance-audit"],
        },
    },
    {
        "role": "connector",
        "name": "NetworkWeaver",
        "capabilities": ["networking", "matchmaking", "event-coordination", "relationship-management"],
        "clusters": ["AI Research", "Venture Capital", "Business Development"],
        "principal": {
            "industry": "professional-networking",
            "role": "community-builder",
            "expertise": ["ai-ecosystem", "startup-community", "cross-industry"],
            "bio": "Professional connector bridging AI research and industry.",
            "looking_for": ["interesting-people", "collaboration-opportunities"],
            "can_offer": ["warm-introductions", "community-access", "event-invitations"],
        },
    },
]


# ============================================================
# Simulation State
# ============================================================

@dataclass
class SimAgent:
    """A simulated agent with its SDK client."""
    id: str
    role: str
    client: MoltBridge
    profile: dict
    registered: bool = False
    seed_hex: str = ""


@dataclass
class SimResult:
    """Result of a single test step."""
    test: str
    passed: bool
    message: str
    duration_ms: float = 0


@dataclass
class SimReport:
    """Full simulation report."""
    run_id: str
    agent_count: int
    results: list[SimResult] = field(default_factory=list)
    start_time: float = 0
    end_time: float = 0

    @property
    def passed(self) -> int:
        return sum(1 for r in self.results if r.passed)

    @property
    def failed(self) -> int:
        return sum(1 for r in self.results if not r.passed)

    @property
    def duration_s(self) -> float:
        return self.end_time - self.start_time

    def summary(self) -> str:
        lines = [
            "=" * 70,
            f"MOLTBRIDGE SIMULATION REPORT — run={self.run_id}",
            f"Agents: {self.agent_count} | Tests: {len(self.results)} | "
            f"Passed: {self.passed} | Failed: {self.failed} | "
            f"Duration: {self.duration_s:.1f}s",
            "=" * 70,
        ]
        for r in self.results:
            status = "PASS" if r.passed else "FAIL"
            lines.append(f"  [{status}] {r.test}: {r.message} ({r.duration_ms:.0f}ms)")
        lines.append("=" * 70)
        if self.failed == 0:
            lines.append("ALL TESTS PASSED — PLATFORM IS LAUNCH-READY")
        else:
            lines.append(f"FAILURES: {self.failed} test(s) failed — review above")
        lines.append("=" * 70)
        return "\n".join(lines)


# ============================================================
# Test Runner
# ============================================================

class MoltBridgeSimulation:
    """Multi-agent simulation test for MoltBridge platform."""

    def __init__(self, base_url: str = DEFAULT_BASE_URL):
        self.base_url = base_url
        self.run_id = ''.join(random.choices(string.ascii_lowercase + string.digits, k=8))
        self.agents: list[SimAgent] = []
        self.report = SimReport(run_id=self.run_id, agent_count=0)

    def _agent_id(self, index: int) -> str:
        return f"{SIM_PREFIX}-{self.run_id}-{index:02d}"

    def _run_test(self, name: str, fn) -> SimResult:
        """Run a test function and capture the result."""
        start = time.time()
        try:
            msg = fn()
            elapsed = (time.time() - start) * 1000
            result = SimResult(test=name, passed=True, message=msg or "OK", duration_ms=elapsed)
        except Exception as e:
            elapsed = (time.time() - start) * 1000
            result = SimResult(test=name, passed=False, message=str(e)[:200], duration_ms=elapsed)
        self.report.results.append(result)
        status = "PASS" if result.passed else "FAIL"
        print(f"  [{status}] {name}: {result.message} ({result.duration_ms:.0f}ms)")
        return result

    # ========================
    # Phase 1: Registration
    # ========================

    def phase_registration(self):
        print("\n--- PHASE 1: Verification & Registration ---")

        for i, profile in enumerate(AGENT_PROFILES):
            agent_id = self._agent_id(i)

            # Rate limit: public tier = 60/min, burst=10. Each registration = 2 public requests
            # (verify + register). With 10 agents, that's 20 requests. Need 4s gaps to stay
            # well within the 60/min sustained rate and let burst tokens refill.
            if i > 0:
                time.sleep(4)

            def register_agent(aid=agent_id, prof=profile):
                client = MoltBridge(agent_id=aid, base_url=self.base_url)

                # Verify
                vr = client.verify()
                assert vr.verified, "Verification failed"

                # Register
                reg = client.register(
                    name=prof["name"],
                    platform="simulation",
                    capabilities=prof.get("capabilities", []),
                    clusters=prof.get("clusters", []),
                )
                agent = reg["agent"]
                assert agent["id"] == aid

                sim_agent = SimAgent(
                    id=aid,
                    role=prof["role"],
                    client=client,
                    profile=prof,
                    registered=True,
                    seed_hex=client._signer.seed_hex if client._signer else "",
                )
                self.agents.append(sim_agent)
                return f"{prof['name']} ({aid}) trust={agent.get('trust_score', 0)}"

            self._run_test(f"register-{profile['role']}", register_agent)

        self.report.agent_count = len(self.agents)

    # ========================
    # Phase 2: Profile & Principal
    # ========================

    def phase_profiles(self):
        print("\n--- PHASE 2: Profile Updates & Principal Onboarding ---")

        for agent in self.agents:
            # Profile update
            def update_profile(a=agent):
                a.client.update_profile(
                    capabilities=a.profile.get("capabilities", []) + ["simulation-tested"],
                )
                return f"Updated {a.role} with simulation-tested capability"

            self._run_test(f"profile-{agent.role}", update_profile)

            # Principal onboarding (if profile has principal data)
            if "principal" in agent.profile:
                def onboard_principal(a=agent):
                    p = a.profile["principal"]
                    result = a.client.onboard_principal(**p)
                    return f"Onboarded principal: {p.get('industry', 'N/A')}/{p.get('role', 'N/A')}"

                self._run_test(f"principal-{agent.role}", onboard_principal)

    # ========================
    # Phase 3: Discovery
    # ========================

    def phase_discovery(self):
        print("\n--- PHASE 3: Discovery ---")

        # Capability discovery — each agent searches for others
        seeker = self.agents[0]  # research-assistant
        for cap in ["crm", "code-review", "financial-analysis", "networking"]:
            def discover_cap(s=seeker, c=cap):
                result = s.client.discover_capability(needs=[c])
                return f"Found {len(result.results)} agents with '{c}'"

            self._run_test(f"discover-cap-{cap}", discover_cap)

        # Broker discovery — try to find paths between diverse agents
        pairs = [(0, -1), (1, -2), (2, -3)]
        for src_idx, tgt_idx in pairs:
            if abs(tgt_idx) > len(self.agents) or src_idx >= len(self.agents):
                continue
            src = self.agents[src_idx]
            tgt = self.agents[tgt_idx]
            if src.id == tgt.id:
                continue

            def discover_broker(s=src, t=tgt):
                result = s.client.discover_broker(target=t.id)
                return f"path_found={result.path_found} ({s.role} -> {t.role})"

            self._run_test(f"discover-broker-{src.role}->{tgt.role}", discover_broker)

    # ========================
    # Phase 4: Trust Building
    # ========================

    def phase_trust(self):
        print("\n--- PHASE 4: Attestations & Trust Building ---")

        # Create a realistic attestation network
        attestation_pairs = [
            (0, 9, "INTERACTION", 0.9),   # research <-> connector
            (9, 0, "INTERACTION", 0.85),   # connector -> research
            (1, 4, "INTERACTION", 0.8),    # sales <-> investor
            (4, 1, "CAPABILITY", 0.75),    # investor attests sales capability
            (2, 7, "CAPABILITY", 0.9),     # code-review attests data-engineer
            (3, 6, "INTERACTION", 0.7),    # recruiter <-> content
            (9, 4, "INTERACTION", 0.95),   # connector <-> investor (strong)
            (9, 1, "INTERACTION", 0.8),    # connector <-> sales
            (9, 3, "INTERACTION", 0.85),   # connector <-> recruiter
            (8, 2, "CAPABILITY", 0.8),     # legal attests code-review (security)
            (5, 6, "INTERACTION", 0.7),    # support <-> content
        ]

        for src_idx, tgt_idx, att_type, confidence in attestation_pairs:
            if src_idx >= len(self.agents) or tgt_idx >= len(self.agents):
                continue
            src = self.agents[src_idx]
            tgt = self.agents[tgt_idx]

            def attest(s=src, t=tgt, at=att_type, c=confidence):
                result = s.client.attest(
                    target_agent=t.id,
                    attestation_type=at,
                    confidence=c,
                )
                return f"{s.role}->{t.role} ({at}, conf={c}) new_trust={result.target_trust_score:.4f}"

            self._run_test(f"attest-{src.role}->{tgt.role}", attest)

    # ========================
    # Phase 5: Credibility
    # ========================

    def phase_credibility(self):
        print("\n--- PHASE 5: Credibility Packets ---")

        # The connector (agent 9) brokers introductions
        if len(self.agents) >= 10:
            connector = self.agents[9]  # NetworkWeaver

            # Connector introduces investor to research
            def cred_investor_research():
                result = connector.client.credibility_packet(
                    target=self.agents[0].id,  # research
                    broker=connector.id,
                )
                return f"packet_len={len(result.packet)}, expires={result.expires_in}s"

            self._run_test("credibility-connector->research", cred_investor_research)

            # Research requests credibility about connector
            def cred_research_connector():
                result = self.agents[0].client.credibility_packet(
                    target=connector.id,
                    broker=self.agents[0].id,
                )
                return f"packet_len={len(result.packet)}"

            self._run_test("credibility-research->connector", cred_research_connector)

    # ========================
    # Phase 6: Outcomes
    # ========================

    def phase_outcomes(self):
        print("\n--- PHASE 6: Outcomes & Bilateral Verification ---")

        if len(self.agents) < 3:
            return

        # Agent 0 creates an introduction outcome
        requester = self.agents[0]
        broker = self.agents[9] if len(self.agents) > 9 else self.agents[1]
        target = self.agents[4] if len(self.agents) > 4 else self.agents[2]

        outcome_id = f"intro-{self.run_id}-001"

        def create_outcome():
            result = requester.client._request("POST", "/outcomes", body={
                "introduction_id": outcome_id,
                "requester_id": requester.id,
                "broker_id": broker.id,
                "target_id": target.id,
            })
            return f"outcome created: {outcome_id}"

        self._run_test("outcome-create", create_outcome)

        # Requester reports success
        if outcome_id:
            def report_requester():
                result = requester.client._request("POST", "/report-outcome", body={
                    "introduction_id": outcome_id,
                    "status": "successful",
                    "evidence_type": "requester_report",
                })
                return f"requester reported: {result.get('resolution_status', 'submitted')}"

            self._run_test("outcome-report-requester", report_requester)

            # Target reports success (bilateral)
            def report_target():
                result = target.client._request("POST", "/report-outcome", body={
                    "introduction_id": outcome_id,
                    "status": "successful",
                    "evidence_type": "target_report",
                })
                return f"target reported: {result.get('resolution_status', 'submitted')}"

            self._run_test("outcome-report-target", report_target)

        # Check pending outcomes
        def check_pending():
            result = requester.client._request("GET", "/outcomes/pending")
            pending = result.get("outcomes", [])
            return f"{len(pending)} pending outcomes"

        self._run_test("outcome-pending", check_pending)

        # Agent stats
        def check_stats():
            result = requester.client._request("GET", f"/outcomes/agent/{requester.id}/stats")
            return f"stats: {json.dumps(result)[:150]}"

        self._run_test("outcome-stats", check_stats)

    # ========================
    # Phase 7: IQS
    # ========================

    def phase_iqs(self):
        print("\n--- PHASE 7: IQS Evaluation ---")

        if len(self.agents) < 2:
            return

        agent = self.agents[0]
        target = self.agents[4] if len(self.agents) > 4 else self.agents[1]

        def evaluate_iqs():
            result = agent.client.evaluate_iqs(
                target_id=target.id,
                requester_capabilities=agent.profile.get("capabilities", []),
                target_capabilities=target.profile.get("capabilities", []),
                hops=2,
            )
            return f"band={result.band}, recommendation={result.recommendation[:80]}"

        self._run_test("iqs-evaluate", evaluate_iqs)

    # ========================
    # Phase 8: Consent
    # ========================

    def phase_consent(self):
        print("\n--- PHASE 8: Consent Lifecycle ---")

        agent = self.agents[0]

        # Check status
        def consent_status():
            result = agent.client.consent_status()
            return f"purposes: {list(result.consents.keys())}"

        self._run_test("consent-status", consent_status)

        # Withdraw a consent
        def consent_withdraw():
            result = agent.client.withdraw_consent("data_sharing")
            return f"withdrawn: data_sharing, granted={result.granted}"

        self._run_test("consent-withdraw", consent_withdraw)

        # Re-grant
        def consent_grant():
            result = agent.client.grant_consent("data_sharing")
            return f"re-granted: data_sharing, granted={result.granted}"

        self._run_test("consent-grant", consent_grant)

        # Export
        def consent_export():
            result = agent.client.export_consent_data()
            return f"exported: {len(json.dumps(result))} bytes"

        self._run_test("consent-export", consent_export)

    # ========================
    # Phase 9: Payments
    # ========================

    def phase_payments(self):
        print("\n--- PHASE 9: Payment System ---")

        # Create accounts for several agents
        for agent in self.agents[:3]:
            tier = "founding" if agent == self.agents[0] else "standard"

            def create_account(a=agent, t=tier):
                a.client.create_payment_account(tier=t)
                return f"account created ({t} tier)"

            self._run_test(f"payment-account-{agent.role}", create_account)

        # Deposit funds
        def deposit():
            result = self.agents[0].client.deposit(100.0)
            return f"deposited ${result.amount}, balance=${result.balance_after}"

        self._run_test("payment-deposit", deposit)

        # Check balance (use raw request since SDK type may not match server response)
        def check_balance():
            result = self.agents[0].client._request("GET", "/payments/balance")
            b = result.get("balance", {})
            return f"balance=${b.get('balance', 0)}, tier={b.get('broker_tier', 'N/A')}"

        self._run_test("payment-balance", check_balance)

        # Transaction history
        def check_history():
            result = self.agents[0].client.payment_history()
            return f"{len(result)} transactions"

        self._run_test("payment-history", check_history)

        # Pricing (no auth)
        def check_pricing():
            result = self.agents[0].client.pricing()
            return f"pricing: {json.dumps(result['pricing'])}"

        self._run_test("payment-pricing", check_pricing)

    # ========================
    # Phase 10: Webhooks
    # ========================

    def phase_webhooks(self):
        print("\n--- PHASE 10: Webhooks ---")

        agent = self.agents[0]

        # Register webhook
        def register_webhook():
            result = agent.client.register_webhook(
                endpoint_url=f"https://example.com/webhooks/{agent.id}",
                event_types=["outcome_reported", "trust_score_changed"],
            )
            return f"registered: {result.endpoint_url}, events={result.event_types}"

        self._run_test("webhook-register", register_webhook)

        # List webhooks
        def list_webhooks():
            result = agent.client.list_webhooks()
            return f"{len(result)} webhooks registered"

        self._run_test("webhook-list", list_webhooks)

        # Unregister
        def unregister_webhook():
            result = agent.client.unregister_webhook(
                endpoint_url=f"https://example.com/webhooks/{agent.id}",
            )
            return f"removed: {result}"

        self._run_test("webhook-unregister", unregister_webhook)

    # ========================
    # Phase 11: Feedback
    # ========================

    def phase_feedback(self):
        print("\n--- PHASE 11: Feedback System ---")

        agent = self.agents[0]
        agent2 = self.agents[1] if len(self.agents) > 1 else agent

        # Bug report
        ticket_id = None

        def report_bug():
            nonlocal ticket_id
            result = agent.client.report_bug(
                title=f"Sim test: Discovery returns stale results (run={self.run_id})",
                description="During simulation testing, capability discovery sometimes returns agents that have been updated but shows old capabilities.",
                endpoint="/discover-capability",
                expected="Updated capabilities reflected immediately",
                actual="Old capabilities shown for ~30 seconds",
                reproducible=True,
            )
            ticket_id = result.ticket_id
            return f"ticket={result.ticket_id}, status={result.status}, priority={result.priority}"

        self._run_test("feedback-bug", report_bug)

        # Feature request
        feature_id = None

        def request_feature():
            nonlocal feature_id
            result = agent.client.request_feature(
                title="Batch discovery API for multiple capability queries",
                description="Allow submitting multiple capability queries in a single request to reduce round-trips.",
                use_case="Agent that needs to find specialists across multiple domains simultaneously.",
                impact="Would reduce API calls by 80% for multi-domain searches.",
            )
            feature_id = result.ticket_id
            return f"ticket={result.ticket_id}, votes={result.vote_count}"

        self._run_test("feedback-feature", request_feature)

        # Vote on feature (from different agent)
        if feature_id:
            def vote_feature():
                result = agent2.client.vote_feedback(feature_id)
                return f"votes after: {result.get('vote_count', 'N/A')}"

            self._run_test("feedback-vote", vote_feature)

        # Comment on bug
        if ticket_id:
            def comment_bug():
                result = agent.client.comment_feedback(
                    ticket_id,
                    "Confirmed this also happens with broker discovery. May be a Neo4j caching issue.",
                )
                return f"comment_id={result.comment_id}"

            self._run_test("feedback-comment", comment_bug)

        # List feedback
        def list_feedback():
            result = agent.client.list_feedback()
            return f"{len(result)} tickets"

        self._run_test("feedback-list", list_feedback)

        # Quality score
        def feedback_quality():
            result = agent.client.feedback_quality()
            return f"quality={result.quality_score}, trust_adj={result.trust_adjustment}"

        self._run_test("feedback-quality", feedback_quality)

    # ========================
    # Phase 12: Post-Trust Discovery
    # ========================

    def phase_post_trust_discovery(self):
        """Re-run discovery after trust has been built to verify graph changes."""
        print("\n--- PHASE 12: Post-Trust Discovery (Verify Graph Updates) ---")

        if len(self.agents) < 10:
            return

        connector = self.agents[9]

        # Connector should now be well-connected — test broker discovery
        def broker_after_trust():
            result = connector.client.discover_broker(target=self.agents[0].id)
            return f"path_found={result.path_found} (connector -> research)"

        self._run_test("post-trust-broker", broker_after_trust)

        # Capability discovery with min_trust filter
        def cap_with_trust():
            result = connector.client.discover_capability(
                needs=["networking"],
                min_trust=0.1,
            )
            return f"Found {len(result.results)} agents with networking + trust>=0.1"

        self._run_test("post-trust-capability", cap_with_trust)

    # ========================
    # Phase 13: GDPR Erasure
    # ========================

    def phase_gdpr_erasure(self):
        """Test GDPR right-to-erasure on one agent."""
        print("\n--- PHASE 13: GDPR Right to Erasure ---")

        if len(self.agents) < 8:
            return

        # Use a less-connected agent for erasure test
        agent = self.agents[7]  # data-engineer

        def erase_data():
            result = agent.client.erase_consent_data()
            return f"erased={result.get('erased', False)}"

        self._run_test("gdpr-erase", erase_data)

    # ========================
    # Run All Phases
    # ========================

    def run(self):
        """Run the full simulation."""
        print(f"\nMOLTBRIDGE MULTI-AGENT SIMULATION")
        print(f"Run ID: {self.run_id}")
        print(f"API: {self.base_url}")
        print(f"Agents: {len(AGENT_PROFILES)}")

        self.report.start_time = time.time()

        # Health check first
        def health():
            client = MoltBridge(agent_id="health-check", base_url=self.base_url)
            h = client.health()
            assert h["status"] == "healthy"
            assert h["neo4j"]["connected"]
            return f"API healthy, Neo4j connected, uptime={h['uptime']}s"

        self._run_test("health-check", health)

        self.phase_registration()
        self.phase_profiles()
        self.phase_discovery()
        self.phase_trust()
        self.phase_credibility()
        self.phase_outcomes()
        self.phase_iqs()
        self.phase_consent()
        self.phase_payments()
        self.phase_webhooks()
        self.phase_feedback()
        self.phase_post_trust_discovery()
        self.phase_gdpr_erasure()

        self.report.end_time = time.time()

        print("\n" + self.report.summary())

        # Save report
        report_path = os.path.join(
            os.path.dirname(__file__), '..', f'simulation-report-{self.run_id}.json'
        )
        with open(report_path, 'w') as f:
            json.dump({
                "run_id": self.run_id,
                "base_url": self.base_url,
                "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                "agent_count": self.report.agent_count,
                "total_tests": len(self.report.results),
                "passed": self.report.passed,
                "failed": self.report.failed,
                "duration_seconds": round(self.report.duration_s, 1),
                "results": [
                    {"test": r.test, "passed": r.passed, "message": r.message, "duration_ms": round(r.duration_ms)}
                    for r in self.report.results
                ],
                "agent_ids": [a.id for a in self.agents],
            }, f, indent=2)

        print(f"\nReport saved to: {report_path}")
        return self.report.failed == 0


# ============================================================
# Cleanup
# ============================================================

def cleanup(run_id: Optional[str] = None, base_url: str = DEFAULT_BASE_URL):
    """Remove simulation test data from Neo4j."""
    try:
        from neo4j import GraphDatabase
    except ImportError:
        print("Installing neo4j driver for cleanup...")
        import subprocess
        subprocess.check_call([sys.executable, "-m", "pip", "install", "--user", "--break-system-packages", "neo4j", "-q"])
        from neo4j import GraphDatabase

    # Load env
    env_path = os.path.join(os.path.dirname(__file__), '..', '.env')
    env = {}
    if os.path.exists(env_path):
        with open(env_path) as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith('#') and '=' in line:
                    k, v = line.split('=', 1)
                    env[k] = v

    uri = env.get("NEO4J_URI", os.environ.get("NEO4J_URI", ""))
    user = env.get("NEO4J_USER", os.environ.get("NEO4J_USER", "neo4j"))
    password = env.get("NEO4J_PASSWORD", os.environ.get("NEO4J_PASSWORD", ""))

    if not uri or not password:
        print("ERROR: Cannot cleanup — NEO4J_URI and NEO4J_PASSWORD required")
        return False

    driver = GraphDatabase.driver(uri, auth=(user, password))

    try:
        with driver.session() as session:
            if run_id:
                prefix = f"{SIM_PREFIX}-{run_id}-"
                print(f"Cleaning up agents matching: {prefix}*")
            else:
                prefix = f"{SIM_PREFIX}-"
                print(f"Cleaning up ALL simulation agents matching: {prefix}*")

            # Count agents to delete
            result = session.run(
                "MATCH (a:Agent) WHERE a.id STARTS WITH $prefix RETURN count(a) AS count",
                prefix=prefix,
            )
            count = result.single()["count"]
            print(f"Found {count} agents to delete")

            if count == 0:
                print("Nothing to clean up")
                return True

            # Delete agents and all their relationships
            result = session.run(
                "MATCH (a:Agent) WHERE a.id STARTS WITH $prefix DETACH DELETE a RETURN count(a) AS deleted",
                prefix=prefix,
            )
            deleted = result.single()["deleted"]
            print(f"Deleted {deleted} agents and their relationships")

            # Also clean up any Principal nodes
            result = session.run(
                "MATCH (p:Principal) WHERE p.agent_id STARTS WITH $prefix DETACH DELETE p RETURN count(p) AS deleted",
                prefix=prefix,
            )
            p_deleted = result.single()["deleted"]
            if p_deleted > 0:
                print(f"Deleted {p_deleted} principal profiles")

            # Clean up any Outcome nodes
            result = session.run(
                "MATCH (o:Outcome) WHERE o.requester_id STARTS WITH $prefix OR o.broker_id STARTS WITH $prefix DETACH DELETE o RETURN count(o) AS deleted",
                prefix=prefix,
            )
            o_deleted = result.single()["deleted"]
            if o_deleted > 0:
                print(f"Deleted {o_deleted} outcomes")

            print("Cleanup complete!")
            return True

    finally:
        driver.close()


# ============================================================
# Entry Point
# ============================================================

def main():
    parser = argparse.ArgumentParser(description="MoltBridge Multi-Agent Simulation")
    parser.add_argument("--base-url", default=DEFAULT_BASE_URL, help="API base URL")
    parser.add_argument("--cleanup", action="store_true", help="Clean up after running")
    parser.add_argument("--cleanup-only", action="store_true", help="Only cleanup, don't run")
    parser.add_argument("--run-id", help="Specific run ID to clean up")
    args = parser.parse_args()

    if args.cleanup_only:
        success = cleanup(run_id=args.run_id, base_url=args.base_url)
        sys.exit(0 if success else 1)

    # Run simulation
    sim = MoltBridgeSimulation(base_url=args.base_url)
    success = sim.run()

    if args.cleanup:
        print("\n--- CLEANUP ---")
        cleanup(run_id=sim.run_id, base_url=args.base_url)

    sys.exit(0 if success else 1)


if __name__ == "__main__":
    main()
