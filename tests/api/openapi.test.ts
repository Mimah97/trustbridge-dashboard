import { describe, expect, it } from "vitest";
import { GET } from "@/app/api/openapi.json/route";

describe("/api/openapi.json", () => {
  it("returns OpenAPI spec with 200 status (success path)", async () => {
    const request = new Request("http://localhost:3000/api/openapi.json", {
      method: "GET",
    });

    const response = await GET(request);

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("application/json");
  });

  it("returns valid OpenAPI 3.0.0 specification", async () => {
    const request = new Request("http://localhost:3000/api/openapi.json", {
      method: "GET",
    });

    const response = await GET(request);
    const spec = await response.json();

    expect(spec.openapi).toBe("3.0.0");
    expect(spec.info).toBeDefined();
    expect(spec.paths).toBeDefined();
    expect(spec.servers).toBeDefined();
  });

  it("includes all required API paths", async () => {
    const request = new Request("http://localhost:3000/api/openapi.json");
    const response = await GET(request);
    const spec = await response.json();

    expect(spec.paths["/api/register"]).toBeDefined();
    expect(spec.paths["/api/check"]).toBeDefined();
    expect(spec.paths["/api/contributors"]).toBeDefined();
    expect(spec.paths["/api/stats"]).toBeDefined();
    expect(spec.paths["/api/metrics"]).toBeDefined();
    expect(spec.paths["/api/metrics/prometheus"]).toBeDefined();
    expect(spec.paths["/api/disputes"]).toBeDefined();
    expect(spec.paths["/api/contributors/queue/health"]).toBeDefined();
    expect(spec.paths["/api/contributors/queue/status"]).toBeDefined();
    expect(spec.paths["/api/contributors/queue/progress"]).toBeDefined();
    expect(spec.paths["/api/contributors/queue/jobs/{jobId}"]).toBeDefined();
    expect(spec.paths["/api/contributors/queue/dlq"]).toBeDefined();
    expect(
      spec.paths["/api/contributors/queue/dlq/{jobId}/retry"]
    ).toBeDefined();
    expect(spec.paths["/api/maintainer/ban"]).toBeDefined();
    expect(spec.paths["/api/registrations/{id}/restore"]).toBeDefined();
  });

  it("documents metrics, disputes, and queue methods and auth requirements", async () => {
    const request = new Request("http://localhost:3000/api/openapi.json");
    const response = await GET(request);
    const spec = await response.json();

    expect(spec.paths["/api/metrics"].get.security).toEqual([
      { bearerAuth: [] },
    ]);
    expect(spec.paths["/api/metrics/prometheus"].get.responses["200"].content[
      "text/plain"
    ]).toBeDefined();
    expect(spec.paths["/api/disputes"]).toHaveProperty("get");
    expect(spec.paths["/api/disputes"]).toHaveProperty("post");
    expect(spec.paths["/api/disputes"]).toHaveProperty("patch");
    expect(
      spec.paths["/api/contributors/queue/dlq/{jobId}/retry"].post.security
    ).toEqual([{ bearerAuth: [] }]);
  });

  it("documents maintainer ban endpoint with request body and error codes", async () => {
    const request = new Request("http://localhost:3000/api/openapi.json");
    const response = await GET(request);
    const spec = await response.json();

    const banPath = spec.paths["/api/maintainer/ban"]?.post;
    expect(banPath).toBeDefined();
    expect(banPath.operationId).toBe("manageContributorBan");
    expect(banPath.security).toEqual([{ bearerAuth: [] }]);
    expect(banPath.requestBody?.content["application/json"]?.schema?.$ref).toBe(
      "#/components/schemas/BanRequest"
    );
    expect(banPath.responses["200"]).toBeDefined();
    expect(banPath.responses["400"]).toBeDefined();
    expect(banPath.responses["403"]).toBeDefined();
    expect(banPath.responses["500"]).toBeDefined();
  });

  it("documents registration restore endpoint with path param and error codes", async () => {
    const request = new Request("http://localhost:3000/api/openapi.json");
    const response = await GET(request);
    const spec = await response.json();

    const restorePath = spec.paths["/api/registrations/{id}/restore"]?.post;
    expect(restorePath).toBeDefined();
    expect(restorePath.operationId).toBe("restoreRegistration");
    expect(restorePath.security).toEqual([{ bearerAuth: [] }]);

    const idParam = restorePath.parameters?.find((p: any) => p.name === "id");
    expect(idParam).toBeDefined();
    expect(idParam.in).toBe("path");
    expect(idParam.required).toBe(true);

    expect(restorePath.responses["200"]).toBeDefined();
    expect(restorePath.responses["403"]).toBeDefined();
    expect(restorePath.responses["404"]).toBeDefined();
    expect(restorePath.responses["409"]).toBeDefined();
  });

  it("generates correct server URL from request", async () => {
    const request = new Request("https://api.trustbridge.example.com/api/openapi.json");
    const response = await GET(request);
    const spec = await response.json();

    expect(spec.servers[0].url).toBe("https://api.trustbridge.example.com");
  });

  it("sets appropriate cache headers", async () => {
    const request = new Request("http://localhost:3000/api/openapi.json");
    const response = await GET(request);

    const cacheControl = response.headers.get("Cache-Control");
    expect(cacheControl).toContain("public");
    expect(cacheControl).toContain("max-age=3600");
  });

  it("includes info with title and version", async () => {
    const request = new Request("http://localhost:3000/api/openapi.json");
    const response = await GET(request);
    const spec = await response.json();

    expect(spec.info.title).toBe("TrustBridge Dashboard API");
    expect(spec.info.version).toBe("1.0.0");
    expect(spec.info.description).toBeDefined();
  });

  it("includes component schemas for data models", async () => {
    const request = new Request("http://localhost:3000/api/openapi.json");
    const response = await GET(request);
    const spec = await response.json();

    expect(spec.components).toBeDefined();
    expect(spec.components.schemas).toBeDefined();
    expect(spec.components.schemas.Registration).toBeDefined();
    expect(spec.components.schemas.DashboardStats).toBeDefined();
    expect(spec.components.schemas.BanRequest).toBeDefined();
    expect(spec.components.schemas.BanResponse).toBeDefined();
    expect(spec.components.schemas.RestoreRegistrationResponse).toBeDefined();
    expect(spec.components.schemas.ErrorResponse).toBeDefined();
  });

  it("documents endpoint parameters for pagination", async () => {
    const request = new Request("http://localhost:3000/api/openapi.json");
    const response = await GET(request);
    const spec = await response.json();

    const contributorsGet = spec.paths["/api/contributors"].get;
    const parameters = contributorsGet.parameters;

    const cursorParam = parameters.find((p: any) => p.name === "cursor");
    const limitParam = parameters.find((p: any) => p.name === "limit");

    expect(cursorParam).toBeDefined();
    expect(limitParam).toBeDefined();
    expect(limitParam.schema.maximum).toBe(100);
  });

  it("documents security schemes", async () => {
    const request = new Request("http://localhost:3000/api/openapi.json");
    const response = await GET(request);
    const spec = await response.json();

    expect(spec.components.securitySchemes).toBeDefined();
    expect(spec.components.securitySchemes.bearerAuth).toBeDefined();
  });

  it("handles URL parsing for different protocols", async () => {
    // Test HTTPS
    const httpsRequest = new Request("https://example.com/api/openapi.json");
    const httpsResponse = await GET(httpsRequest);
    const httpsSpec = await httpsResponse.json();

    expect(httpsSpec.servers[0].url).toContain("https://");

    // Test HTTP
    const httpRequest = new Request("http://example.com/api/openapi.json");
    const httpResponse = await GET(httpRequest);
    const httpSpec = await httpResponse.json();

    expect(httpSpec.servers[0].url).toContain("http://");
  });
});
