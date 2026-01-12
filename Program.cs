using System.Diagnostics;
using Microsoft.AspNetCore.OutputCaching;
using Microsoft.AspNetCore.ResponseCompression;

var builder = WebApplication.CreateBuilder(args);

// Compression helps a lot when sending JSON (especially /api/raw).
builder.Services.AddResponseCompression(o =>
{
    o.EnableForHttps = true;
    o.Providers.Add<GzipCompressionProvider>();
});
builder.Services.Configure<GzipCompressionProviderOptions>(o =>
{
    o.Level = System.IO.Compression.CompressionLevel.Fastest;
});

// Server-side response caching (repeatable queries become snappier)
builder.Services.AddOutputCache(o =>
{
    o.AddBasePolicy(p => p.Expire(TimeSpan.FromSeconds(20)));
});

var app = builder.Build();

app.UseResponseCompression();
app.UseOutputCache();

app.UseDefaultFiles();
app.UseStaticFiles();

app.MapGet("/api/raw", (int points = 200_000, int seed = 1) =>
{
    // Intentionally heavy endpoint: generates + serializes all points.
    points = Math.Clamp(points, 1_000, 1_000_000);

    var sw = Stopwatch.StartNew();

    // Array of pairs [x,y] -> easy for JS, heavy for JSON.
    var data = new double[points][];
    for (int i = 0; i < points; i++)
    {
        var v = Signal(i, seed);
        data[i] = new[] { (double)i, v };
    }

    sw.Stop();

    return Results.Json(new
    {
        points,
        kind = "raw",
        generatedMs = sw.ElapsedMilliseconds,
        data
    });
})
.CacheOutput(p => p.SetVaryByQuery(new[] { "points", "seed" }));

app.MapGet("/api/aggregate", (int points = 200_000, int buckets = 1200, int seed = 1) =>
{
    // Smart endpoint: 1 pass, returns small "ready-to-plot" buckets.
    points = Math.Clamp(points, 1_000, 1_000_000);
    buckets = Math.Clamp(buckets, 50, 10_000);

    var sw = Stopwatch.StartNew();

    var min = Enumerable.Repeat(double.PositiveInfinity, buckets).ToArray();
    var max = Enumerable.Repeat(double.NegativeInfinity, buckets).ToArray();
    var sum = new double[buckets];
    var cnt = new int[buckets];

    for (int i = 0; i < points; i++)
    {
        var v = Signal(i, seed);
        int b = (int)((long)i * buckets / points); // uniform mapping

        if (v < min[b]) min[b] = v;
        if (v > max[b]) max[b] = v;
        sum[b] += v;
        cnt[b]++;
    }

    var series = new object[buckets];
    for (int b = 0; b < buckets; b++)
    {
        var avg = cnt[b] == 0 ? 0 : sum[b] / cnt[b];
        series[b] = new
        {
            bucket = b,
            min = double.IsInfinity(min[b]) ? 0 : min[b],
            max = double.IsInfinity(max[b]) ? 0 : max[b],
            avg
        };
    }

    sw.Stop();

    return Results.Json(new
    {
        points,
        buckets,
        kind = "aggregate",
        computedMs = sw.ElapsedMilliseconds,
        series
    });
})
.CacheOutput(p => p.SetVaryByQuery(new[] { "points", "buckets", "seed" }));

app.MapGet("/api/ping", () => Results.Ok(new { ok = true, utc = DateTime.UtcNow }));

app.Run();

// Deterministic synthetic “IoT-like” signal: sine waves + deterministic noise.
static double Signal(int i, int seed)
{
    unchecked
    {
        int x = i ^ (seed * 1103515245);
        x = (x * 1664525) + 1013904223;
        var noise = ((x >>> 8) & 0xFFFF) / 65535.0 - 0.5; // [-0.5..0.5]
        var wave = Math.Sin(i / 250.0) + 0.4 * Math.Sin(i / 37.0);
        return wave + 0.25 * noise;
    }
}
