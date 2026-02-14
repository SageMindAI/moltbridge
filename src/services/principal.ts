/**
 * Principal Service
 *
 * Manages human principal profiles submitted by their AI agents.
 * Handles onboarding, profile updates, enrichment level calculation,
 * and visibility controls.
 */

import { getDriver } from '../db/neo4j';
import { MoltBridgeError, Errors } from '../middleware/errors';
import { isSafeString, isValidCapabilityTag } from '../middleware/validate';
import type {
  PrincipalProfile,
  PrincipalOnboardRequest,
  ProfileEnrichmentRequest,
  ExpertiseEntry,
  ProjectEntry,
  EnrichmentLevel,
} from '../types';

export class PrincipalService {

  /**
   * Onboard a principal — agent submits initial profile for its human.
   * Can only be called once per agent.
   */
  async onboard(agentId: string, request: PrincipalOnboardRequest): Promise<PrincipalProfile> {
    // Require at least one meaningful field
    if (!request.industry && !request.role && (!request.expertise || request.expertise.length === 0)) {
      throw Errors.validationError('At least one of industry, role, or expertise is required');
    }

    // Validate string fields
    if (request.industry && !isSafeString(request.industry)) {
      throw Errors.validationError('Invalid industry format');
    }
    if (request.role && !isSafeString(request.role)) {
      throw Errors.validationError('Invalid role format');
    }
    if (request.organization && !isSafeString(request.organization)) {
      throw Errors.validationError('Invalid organization format');
    }
    if (request.bio && request.bio.length > 500) {
      throw Errors.validationError('Bio must be 500 characters or less');
    }

    // Validate expertise tags
    if (request.expertise) {
      for (const tag of request.expertise) {
        if (!isValidCapabilityTag(tag)) {
          throw Errors.validationError(`Invalid expertise tag: '${tag}'. Use lowercase, hyphens only.`);
        }
      }
    }

    const driver = getDriver();
    const session = driver.session();
    const now = new Date().toISOString();

    try {
      // Check agent exists
      const agentCheck = await session.run(
        'MATCH (a:Agent {id: $agentId}) RETURN a.id',
        { agentId }
      );
      if (agentCheck.records.length === 0) {
        throw Errors.agentNotFound(agentId);
      }

      // Check not already onboarded
      const existing = await session.run(
        'MATCH (a:Agent {id: $agentId})-[:PAIRED_WITH]->(h:Human) WHERE h.onboarded_at IS NOT NULL RETURN h.alias',
        { agentId }
      );
      if (existing.records.length > 0) {
        throw Errors.conflict('Principal already onboarded. Use PUT /principal/profile to update.');
      }

      // Build expertise entries
      const expertise: ExpertiseEntry[] = (request.expertise || []).map(tag => ({
        tag,
        verified: false,
        source: 'agent-declared' as const,
        attestation_count: 0,
      }));

      // Calculate enrichment level
      const enrichmentLevel = this.calculateEnrichmentLevel(request, expertise);

      // Update the Human node with profile data
      await session.run(
        `
        MATCH (a:Agent {id: $agentId})-[:PAIRED_WITH]->(h:Human)
        SET h.industry = $industry,
            h.role = $role,
            h.organization = $organization,
            h.bio = $bio,
            h.location = $location,
            h.looking_for = $lookingFor,
            h.can_offer = $canOffer,
            h.interests = $interests,
            h.expertise_tags = $expertiseTags,
            h.onboarded_at = $now,
            h.last_updated = $now,
            h.enrichment_level = $enrichmentLevel
        `,
        {
          agentId,
          industry: request.industry || null,
          role: request.role || null,
          organization: request.organization || null,
          bio: request.bio || null,
          location: request.location || null,
          lookingFor: request.looking_for || [],
          canOffer: request.can_offer || [],
          interests: request.interests || [],
          expertiseTags: (request.expertise || []),
          now,
          enrichmentLevel,
        }
      );

      // Create expertise cluster connections
      for (const tag of (request.expertise || [])) {
        await session.run(
          `
          MATCH (a:Agent {id: $agentId})-[:PAIRED_WITH]->(h:Human)
          MERGE (c:Cluster {name: $tag})
          ON CREATE SET c.type = 'expertise', c.description = ''
          MERGE (h)-[:HAS_EXPERTISE {
            tag: $tag,
            verified: false,
            source: 'agent-declared',
            attestation_count: 0
          }]->(c)
          `,
          { agentId, tag }
        );
      }

      // Create project nodes if provided
      for (const project of (request.projects || [])) {
        await session.run(
          `
          MATCH (a:Agent {id: $agentId})-[:PAIRED_WITH]->(h:Human)
          CREATE (p:Project {
            name: $name,
            description: $description,
            status: $status,
            visibility: $visibility
          })
          CREATE (h)-[:WORKING_ON {
            status: $status,
            visibility: $visibility,
            since: $now
          }]->(p)
          `,
          {
            agentId,
            name: project.name,
            description: project.description || '',
            status: project.status || 'active',
            visibility: project.visibility || 'public',
            now,
          }
        );
      }

      return {
        agent_id: agentId,
        industry: request.industry,
        role: request.role,
        organization: request.organization,
        expertise,
        interests: request.interests || [],
        projects: request.projects || [],
        location: request.location,
        bio: request.bio,
        looking_for: request.looking_for || [],
        can_offer: request.can_offer || [],
        enrichment_level: enrichmentLevel,
        onboarded_at: now,
        last_updated: now,
      };
    } finally {
      await session.close();
    }
  }

  /**
   * Update a principal's profile. Additive by default (appends to arrays).
   * Set replace: true to overwrite instead.
   */
  async updateProfile(agentId: string, update: ProfileEnrichmentRequest): Promise<PrincipalProfile> {
    const driver = getDriver();
    const session = driver.session();
    const now = new Date().toISOString();

    try {
      // Get existing profile
      const existing = await session.run(
        `
        MATCH (a:Agent {id: $agentId})-[:PAIRED_WITH]->(h:Human)
        WHERE h.onboarded_at IS NOT NULL
        RETURN h
        `,
        { agentId }
      );

      if (existing.records.length === 0) {
        throw Errors.validationError('Principal not onboarded yet. Use POST /principal/onboard first.');
      }

      const node = existing.records[0].get('h').properties;

      // Build SET clauses
      const setClauses: string[] = ['h.last_updated = $now'];
      const params: Record<string, any> = { agentId, now };

      // Scalar fields — always replace
      if (update.industry !== undefined) {
        setClauses.push('h.industry = $industry');
        params.industry = update.industry;
      }
      if (update.role !== undefined) {
        setClauses.push('h.role = $role');
        params.role = update.role;
      }
      if (update.organization !== undefined) {
        setClauses.push('h.organization = $organization');
        params.organization = update.organization;
      }
      if (update.bio !== undefined) {
        if (update.bio.length > 500) throw Errors.validationError('Bio must be 500 characters or less');
        setClauses.push('h.bio = $bio');
        params.bio = update.bio;
      }
      if (update.location !== undefined) {
        setClauses.push('h.location = $location');
        params.location = update.location;
      }

      // Array fields — append or replace
      if (update.interests !== undefined) {
        if (update.replace) {
          setClauses.push('h.interests = $interests');
          params.interests = update.interests;
        } else {
          const merged = [...new Set([...(node.interests || []), ...update.interests])];
          setClauses.push('h.interests = $interests');
          params.interests = merged;
        }
      }
      if (update.looking_for !== undefined) {
        if (update.replace) {
          setClauses.push('h.looking_for = $lookingFor');
          params.lookingFor = update.looking_for;
        } else {
          const merged = [...new Set([...(node.looking_for || []), ...update.looking_for])];
          setClauses.push('h.looking_for = $lookingFor');
          params.lookingFor = merged;
        }
      }
      if (update.can_offer !== undefined) {
        if (update.replace) {
          setClauses.push('h.can_offer = $canOffer');
          params.canOffer = update.can_offer;
        } else {
          const merged = [...new Set([...(node.can_offer || []), ...update.can_offer])];
          setClauses.push('h.can_offer = $canOffer');
          params.canOffer = merged;
        }
      }
      if (update.expertise !== undefined) {
        for (const tag of update.expertise) {
          if (!isValidCapabilityTag(tag)) {
            throw Errors.validationError(`Invalid expertise tag: '${tag}'`);
          }
        }
        if (update.replace) {
          setClauses.push('h.expertise_tags = $expertiseTags');
          params.expertiseTags = update.expertise;
        } else {
          const merged = [...new Set([...(node.expertise_tags || []), ...update.expertise])];
          setClauses.push('h.expertise_tags = $expertiseTags');
          params.expertiseTags = merged;
        }

        // Create new expertise cluster connections
        for (const tag of update.expertise) {
          await session.run(
            `
            MATCH (a:Agent {id: $agentId})-[:PAIRED_WITH]->(h:Human)
            MERGE (c:Cluster {name: $tag})
            ON CREATE SET c.type = 'expertise', c.description = ''
            MERGE (h)-[:HAS_EXPERTISE {
              tag: $tag,
              verified: false,
              source: 'agent-declared',
              attestation_count: 0
            }]->(c)
            `,
            { agentId, tag }
          );
        }
      }

      // Apply updates
      await session.run(
        `MATCH (a:Agent {id: $agentId})-[:PAIRED_WITH]->(h:Human) SET ${setClauses.join(', ')}`,
        params
      );

      // Fetch updated profile
      return this.getProfile(agentId);
    } finally {
      await session.close();
    }
  }

  /**
   * Get full principal profile (for owning agent).
   */
  async getProfile(agentId: string): Promise<PrincipalProfile> {
    const driver = getDriver();
    const session = driver.session();

    try {
      const result = await session.run(
        `
        MATCH (a:Agent {id: $agentId})-[:PAIRED_WITH]->(h:Human)
        OPTIONAL MATCH (h)-[e:HAS_EXPERTISE]->(c:Cluster)
        OPTIONAL MATCH (h)-[w:WORKING_ON]->(p:Project)
        RETURN h,
               collect(DISTINCT {tag: e.tag, verified: e.verified, source: e.source, attestation_count: e.attestation_count}) AS expertise,
               collect(DISTINCT {name: p.name, description: p.description, status: w.status, visibility: w.visibility}) AS projects
        `,
        { agentId }
      );

      if (result.records.length === 0) {
        throw Errors.agentNotFound(agentId);
      }

      const record = result.records[0];
      const h = record.get('h').properties;
      const rawExpertise = record.get('expertise').filter((e: any) => e.tag != null);
      const rawProjects = record.get('projects').filter((p: any) => p.name != null);

      const expertise: ExpertiseEntry[] = rawExpertise.map((e: any) => ({
        tag: e.tag,
        verified: e.verified ?? false,
        source: e.source || 'agent-declared',
        attestation_count: typeof e.attestation_count === 'number' ? e.attestation_count : 0,
      }));

      const projects: ProjectEntry[] = rawProjects.map((p: any) => ({
        name: p.name,
        description: p.description || undefined,
        status: p.status || 'active',
        visibility: p.visibility || 'public',
      }));

      return {
        agent_id: agentId,
        industry: h.industry || undefined,
        role: h.role || undefined,
        organization: h.organization || undefined,
        expertise,
        interests: h.interests || [],
        projects,
        location: h.location || undefined,
        bio: h.bio || undefined,
        looking_for: h.looking_for || [],
        can_offer: h.can_offer || [],
        enrichment_level: h.enrichment_level || 'none',
        onboarded_at: h.onboarded_at || '',
        last_updated: h.last_updated || '',
      };
    } finally {
      await session.close();
    }
  }

  /**
   * Get the public-facing view of a principal's profile.
   * Only returns fields with 'public' or 'connections' visibility.
   */
  async getVisibility(agentId: string): Promise<Partial<PrincipalProfile>> {
    const profile = await this.getProfile(agentId);

    // Filter projects to public-only
    const publicProjects = profile.projects.filter(p => p.visibility === 'public');

    return {
      agent_id: profile.agent_id,
      industry: profile.industry,
      role: profile.role,
      // organization is connections-only by default in Phase 1
      expertise: profile.expertise,
      interests: profile.interests,
      projects: publicProjects,
      bio: profile.bio,
      looking_for: profile.looking_for,
      can_offer: profile.can_offer,
      enrichment_level: profile.enrichment_level,
    };
  }

  /**
   * Calculate enrichment level based on profile completeness.
   */
  private calculateEnrichmentLevel(
    request: PrincipalOnboardRequest,
    expertise: ExpertiseEntry[]
  ): EnrichmentLevel {
    const hasIndustry = !!request.industry;
    const hasRole = !!request.role;
    const hasBio = !!request.bio;
    const expertiseCount = expertise.length;
    const verifiedCount = expertise.filter(e => e.verified).length;

    // verified: detailed + 2+ peer-attested + 1+ outcome
    if (hasIndustry && hasRole && expertiseCount >= 3 && hasBio && verifiedCount >= 2) {
      return 'verified';
    }
    // detailed: industry AND role AND 3+ expertise AND bio
    if (hasIndustry && hasRole && expertiseCount >= 3 && hasBio) {
      return 'detailed';
    }
    // basic: industry OR role OR 1+ expertise
    if (hasIndustry || hasRole || expertiseCount >= 1) {
      return 'basic';
    }

    return 'none';
  }
}
