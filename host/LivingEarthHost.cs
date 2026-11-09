// Living Earth Himalaya for Windows. Runs the wallpaper using only what ships with Windows: the Edge browser
// and this small app, built by the C# compiler in the .NET Framework (see build.cmd). No install, no admin.
// The page travels inside the exe, so this one file is a complete download. Next to the source code, the app
// uses the page in the folder above it instead.
//
//   1. Opening the app shows the setup window: location (found automatically or chosen by hand), when to
//      animate, what is in the scene (each part can be turned off: road and how much traffic, the tree and its flying
//      leaves, birds, shooting stars, village lights, forest mist, clouds on the peaks, village smoke, burning fields), whether the clock
//      and weather panel shows, its corner and size, quality, Start with Windows, and whether Windows' own background shows the scene too.
//      "Watch the demo" (and the tray menu's "Play the demo") plays a year in two minutes, over and over, until it is
//      turned off; it is not saved, so the next start is the real time and weather again.
//      "Set wallpaper" starts the wallpaper. When Windows starts the app at sign-in (--startup), it goes
//      straight to the wallpaper with the saved settings.
//   2. Starts Edge on index.html with its own profile, at below-normal priority.
//   3. Moves the Edge window behind the desktop icons.
//   4. Tells the page its pace and settings through host/state.js, so the graphics chip is nearly idle
//      while you work and setting changes apply without a restart.
//   5. Keeps Edge in a job object, so Edge can never outlive this app.
//   6. Sets the Windows desktop background to a still of the scene for the part of the day, so Settings >
//      Personalization shows this wallpaper too, and puts the old background back on Exit.
//
// C# 5 on purpose: that is the language level of the compiler that comes with Windows.
using System;
using System.Collections;
using System.Collections.Generic;
using System.Device.Location;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Text;
using System.Globalization;
using System.IO;
using System.IO.Compression;
using System.Net;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Win32;

[assembly: AssemblyTitle("Living Earth Himalaya")]
[assembly: AssemblyProduct("Living Earth Himalaya")]
[assembly: AssemblyCompany("Khan Rafaat Abtahe")]
[assembly: AssemblyCopyright("© 2026 Khan Rafaat Abtahe. MIT licence")]
[assembly: AssemblyDescription("Living Earth Himalaya live wallpaper. Author: Khan Rafaat Abtahe")]
[assembly: AssemblyVersion("2.2.0.0")]
[assembly: AssemblyFileVersion("2.2.0.0")]

namespace LivingEarth
{
    public enum RestMode
    {
        Desktop,   // full animation only while the empty desktop is in front (lightest)
        Maximized, // full animation unless the focused window is maximized or full screen
        Paused,    // keep the current picture, with no updates
        Always     // always full animation: for measuring only, not offered in the window
    }

    public static class Program
    {
        public const string ProjectUrl = "https://github.com/khanRafaat/living-earth-himalaya-windows-live-wallpaper";
        internal const string ShowEventName = @"Local\LivingEarthHostShow";

        [STAThread]
        private static void Main(string[] args)
        {
            // Unpacks the page into a folder and stops: no window and no wallpaper. For the tests.
            if (args.Length == 2 && args[0] == "--unpack-to")
            {
                Directory.CreateDirectory(args[1]);
                Host.UnpackPage(args[1]);
                return;
            }
            bool first;
            using (var mutex = new Mutex(true, @"Local\LivingEarthHost", out first))
            {
                if (!first)
                {
                    // Already running: bring up its window, unless Windows started this copy at sign-in
                    if (Array.IndexOf(args, "--startup") < 0) AskRunningCopyToShow();
                    return;
                }
                try { Native.SetProcessDpiAwarenessContext(new IntPtr(-4)); }
                catch (EntryPointNotFoundException) { Native.SetProcessDPIAware(); }
                // Windows passes this on to child processes. The job object below enforces it as well.
                Process.GetCurrentProcess().PriorityClass = ProcessPriorityClass.BelowNormal;
                ServicePointManager.SecurityProtocol |= (SecurityProtocolType)3072; // TLS 1.2
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                Application.Run(new Host(args));
                GC.KeepAlive(mutex);
            }
        }

        private static void AskRunningCopyToShow()
        {
            EventWaitHandle h;
            if (EventWaitHandle.TryOpenExisting(ShowEventName, out h))
                using (h) h.Set();
        }
    }

    // ====================================================================== settings
    public sealed class Place
    {
        public readonly double Lat, Lon;
        public readonly string Name;   // short, shown on the wallpaper: "Sylhet"
        public readonly string Detail; // longer, shown in the window: "Sylhet, Sylhet Division, Bangladesh"
        public readonly string Source; // how it was found

        public Place(double lat, double lon, string name, string detail, string source)
        {
            // about 100 m: plenty for the sky, and it doesn't keep a precise position on disk
            Lat = Math.Round(lat, 3);
            Lon = Math.Round(lon, 3);
            Name = Clean(name, 60);
            if (Name.Length == 0) Name = "Your area";
            Detail = Clean(detail, 120);
            if (Detail.Length == 0) Detail = Name;
            Source = Clean(source, 60);
        }

        public override string ToString() { return Detail; }

        private static string Clean(string s, int max)
        {
            if (string.IsNullOrEmpty(s)) return "";
            var b = new StringBuilder();
            foreach (char c in s) if (c >= ' ') b.Append(c);
            string t = b.ToString().Trim();
            return t.Length > max ? t.Substring(0, max) : t;
        }
    }

    public sealed class Settings
    {
        public static readonly string[] Qualities = { "auto", "eco", "balanced", "high", "ultra" };
        // Where the clock and weather panel sits. The same order as PANEL_POS in src/main.js.
        public static readonly string[] Corners = { "right-bottom", "right-top", "left-bottom", "left-top" };
        // Its size. The same order as PANEL_SIZE in src/main.js.
        public static readonly string[] PanelSizes = { "small", "medium", "large" };
        // How much traffic is on the road. The same order as TRAFFIC in src/main.js.
        public static readonly string[] Traffics = { "light", "normal", "busy" };

        public RestMode Mode = RestMode.Desktop;
        public string Quality = "high";
        public bool AutoLocation = true;
        public Place Manual;   // the place chosen by hand
        public Place Detected; // the last place found automatically
        public bool Road = true, Birds = true, Leaves = true; // what is in the scene
        public bool Tree = true, Mist = true, Smoke = true, Fires = true, Lights = true, Stars = true;
        public bool Banners = true; // clouds streaming from the high peaks in the wind
        public bool Panel = true; // the clock and weather panel
        public string Corner = "right-bottom";
        public string PanelSize = "medium";
        public string Traffic = "normal";
        public bool WindowsBackground = true; // Windows' own background shows a still of the scene

        /** The place the wallpaper uses, or null for the page's default. */
        public Place Current { get { return !AutoLocation && Manual != null ? Manual : Detected; } }

        public Settings Copy() { return (Settings)MemberwiseClone(); }

        public static RestMode ParseMode(string s)
        {
            switch (s)
            {
                case "maximized": return RestMode.Maximized;
                case "paused": return RestMode.Paused;
                case "always": return RestMode.Always;
                default: return RestMode.Desktop;
            }
        }

        public static Settings Load(string path)
        {
            var s = new Settings();
            var v = new Dictionary<string, string>();
            try
            {
                if (File.Exists(path))
                    foreach (string line in File.ReadAllLines(path, Encoding.UTF8))
                    {
                        int eq = line.IndexOf('=');
                        if (eq > 0) v[line.Substring(0, eq).Trim()] = line.Substring(eq + 1).Trim();
                    }
            }
            catch (IOException) { }
            catch (UnauthorizedAccessException) { }
            string x;
            if (v.TryGetValue("mode", out x)) s.Mode = ParseMode(x);
            if (v.TryGetValue("quality", out x) && Array.IndexOf(Qualities, x) >= 0) s.Quality = x;
            s.AutoLocation = !(v.TryGetValue("location", out x) && x == "manual");
            s.Manual = ReadPlace(v, "manual");
            s.Detected = ReadPlace(v, "detected");
            // A missing key means on, so a settings file from an older version keeps everything
            s.Road = !(v.TryGetValue("road", out x) && x == "off");
            s.Birds = !(v.TryGetValue("birds", out x) && x == "off");
            s.Leaves = !(v.TryGetValue("leaves", out x) && x == "off");
            s.Tree = !(v.TryGetValue("tree", out x) && x == "off");
            s.Mist = !(v.TryGetValue("mist", out x) && x == "off");
            s.Banners = !(v.TryGetValue("banners", out x) && x == "off");
            s.Smoke = !(v.TryGetValue("smoke", out x) && x == "off");
            s.Fires = !(v.TryGetValue("fires", out x) && x == "off");
            s.Lights = !(v.TryGetValue("lights", out x) && x == "off");
            s.Stars = !(v.TryGetValue("stars", out x) && x == "off");
            s.Panel = !(v.TryGetValue("panel", out x) && x == "off");
            if (v.TryGetValue("corner", out x) && Array.IndexOf(Corners, x) >= 0) s.Corner = x;
            if (v.TryGetValue("panelsize", out x) && Array.IndexOf(PanelSizes, x) >= 0) s.PanelSize = x;
            if (v.TryGetValue("traffic", out x) && Array.IndexOf(Traffics, x) >= 0) s.Traffic = x;
            s.WindowsBackground = !(v.TryGetValue("windowsbackground", out x) && x == "off");
            return s;
        }

        public void Save(string path)
        {
            var b = new StringBuilder();
            b.Append("mode=").Append(Mode.ToString().ToLowerInvariant()).Append("\r\n");
            b.Append("quality=").Append(Quality).Append("\r\n");
            b.Append("location=").Append(AutoLocation ? "auto" : "manual").Append("\r\n");
            b.Append("road=").Append(Road ? "on" : "off").Append("\r\n");
            b.Append("birds=").Append(Birds ? "on" : "off").Append("\r\n");
            b.Append("leaves=").Append(Leaves ? "on" : "off").Append("\r\n");
            b.Append("tree=").Append(Tree ? "on" : "off").Append("\r\n");
            b.Append("mist=").Append(Mist ? "on" : "off").Append("\r\n");
            b.Append("banners=").Append(Banners ? "on" : "off").Append("\r\n");
            b.Append("smoke=").Append(Smoke ? "on" : "off").Append("\r\n");
            b.Append("fires=").Append(Fires ? "on" : "off").Append("\r\n");
            b.Append("lights=").Append(Lights ? "on" : "off").Append("\r\n");
            b.Append("stars=").Append(Stars ? "on" : "off").Append("\r\n");
            b.Append("panel=").Append(Panel ? "on" : "off").Append("\r\n");
            b.Append("corner=").Append(Corner).Append("\r\n");
            b.Append("panelsize=").Append(PanelSize).Append("\r\n");
            b.Append("traffic=").Append(Traffic).Append("\r\n");
            b.Append("windowsbackground=").Append(WindowsBackground ? "on" : "off").Append("\r\n");
            WritePlace(b, "manual", Manual);
            WritePlace(b, "detected", Detected);
            File.WriteAllText(path, b.ToString(), new UTF8Encoding(false));
        }

        private static Place ReadPlace(Dictionary<string, string> v, string key)
        {
            string lat, lon, name, detail, source;
            double a, o;
            if (!v.TryGetValue(key + ".lat", out lat) || !v.TryGetValue(key + ".lon", out lon)) return null;
            if (!double.TryParse(lat, NumberStyles.Float, CultureInfo.InvariantCulture, out a) ||
                !double.TryParse(lon, NumberStyles.Float, CultureInfo.InvariantCulture, out o) ||
                Math.Abs(a) > 90 || Math.Abs(o) > 180) return null;
            v.TryGetValue(key + ".name", out name);
            v.TryGetValue(key + ".detail", out detail);
            v.TryGetValue(key + ".source", out source);
            return new Place(a, o, name, detail, source);
        }

        private static void WritePlace(StringBuilder b, string key, Place p)
        {
            if (p == null) return;
            b.Append(key).Append(".lat=").Append(Locator.F(p.Lat)).Append("\r\n");
            b.Append(key).Append(".lon=").Append(Locator.F(p.Lon)).Append("\r\n");
            b.Append(key).Append(".name=").Append(p.Name).Append("\r\n");
            b.Append(key).Append(".detail=").Append(p.Detail).Append("\r\n");
            b.Append(key).Append(".source=").Append(p.Source).Append("\r\n");
        }
    }

    // ====================================================================== finding places
    /**
     * Windows location first. Without it, the internet connection's approximate place (ipwho.is).
     * Place names come from OpenStreetMap (Nominatim), searches from Open-Meteo, which also gives the weather.
     */
    public static class Locator
    {
        private const string Agent = "LivingEarthWallpaper/2.1 (+" + Program.ProjectUrl + ")";
        public const string FromWindowsText = "Windows location";
        public const string FromInternetText = "your internet connection (approximate)";
        public const string ChosenText = "your choice";

        public static Task<Place> DetectAsync(Place previous, bool mayAsk)
        {
            return Task.Run(() => Detect(previous, mayAsk));
        }

        public static Task<List<Place>> SearchAsync(string text)
        {
            return Task.Run(() => Search(text));
        }

        /** mayAsk: Windows may ask once whether this app can use your location. Not at sign-in. */
        public static Place Detect(Place previous, bool mayAsk)
        {
            double lat, lon;
            if (FromWindows(mayAsk, out lat, out lon))
            {
                // the same place as last time: no need to look its name up again
                if (previous != null && Km(lat, lon, previous.Lat, previous.Lon) < 2)
                    return new Place(lat, lon, previous.Name, previous.Detail, FromWindowsText);
                Place named = null;
                try { named = Reverse(lat, lon); }
                catch (Exception) { }
                return named != null
                    ? new Place(lat, lon, named.Name, named.Detail, FromWindowsText)
                    : new Place(lat, lon, "Your area", Coords(lat, lon), FromWindowsText);
            }
            try { return FromInternet(); }
            catch (Exception) { return null; }
        }

        public static List<Place> Search(string text)
        {
            var list = new List<Place>();
            Match m = Regex.Match(text, @"^\s*([-+]?\d{1,2}(?:\.\d+)?)\s*[,; ]\s*([-+]?\d{1,3}(?:\.\d+)?)\s*$");
            if (m.Success)
            {
                double lat = double.Parse(m.Groups[1].Value, CultureInfo.InvariantCulture);
                double lon = double.Parse(m.Groups[2].Value, CultureInfo.InvariantCulture);
                if (Math.Abs(lat) > 90 || Math.Abs(lon) > 180) return list;
                Place named = null;
                try { named = Reverse(lat, lon); }
                catch (Exception) { }
                list.Add(named != null
                    ? new Place(lat, lon, named.Name, named.Detail + " (" + Coords(lat, lon) + ")", ChosenText)
                    : new Place(lat, lon, "Your area", Coords(lat, lon), ChosenText));
                return list;
            }
            Dictionary<string, object> d = GetJson("https://geocoding-api.open-meteo.com/v1/search?count=8&language=en&format=json&name=" +
                                                   Uri.EscapeDataString(text.Trim()));
            IList rows = d != null && d.ContainsKey("results") ? d["results"] as IList : null;
            if (rows == null) return list;
            foreach (object o in rows)
            {
                var r = o as Dictionary<string, object>;
                if (r == null) continue;
                double lat = Num(r, "latitude"), lon = Num(r, "longitude");
                string name = Str(r, "name");
                if (double.IsNaN(lat) || double.IsNaN(lon) || name.Length == 0) continue;
                list.Add(new Place(lat, lon, name, Join(name, Str(r, "admin1"), Str(r, "country")), ChosenText));
            }
            return list;
        }

        public static bool FromWindows(bool mayAsk, out double lat, out double lon)
        {
            lat = lon = 0;
            try
            {
                using (var w = new GeoCoordinateWatcher(GeoPositionAccuracy.Default))
                {
                    if (!w.TryStart(!mayAsk, TimeSpan.FromSeconds(6))) return false;
                    DateTime until = DateTime.UtcNow.AddSeconds(6);
                    while (w.Position.Location.IsUnknown && w.Permission != GeoPositionPermission.Denied && DateTime.UtcNow < until)
                        Thread.Sleep(200);
                    GeoCoordinate c = w.Position.Location;
                    w.Stop();
                    if (c.IsUnknown || double.IsNaN(c.Latitude) || double.IsNaN(c.Longitude)) return false;
                    lat = c.Latitude;
                    lon = c.Longitude;
                    return true;
                }
            }
            catch (Exception)
            {
                return false; // no location platform, or it is switched off
            }
        }

        public static Place FromInternet()
        {
            Dictionary<string, object> d = GetJson("https://ipwho.is/?fields=success,city,region,country,latitude,longitude");
            if (d == null || !d.ContainsKey("success") || !(d["success"] is bool) || !(bool)d["success"]) return null;
            double lat = Num(d, "latitude"), lon = Num(d, "longitude");
            if (double.IsNaN(lat) || double.IsNaN(lon)) return null;
            string city = Str(d, "city");
            return new Place(lat, lon, city, Join(city, Str(d, "region"), Str(d, "country")), FromInternetText);
        }

        /** City-level name for a position, from OpenStreetMap. */
        public static Place Reverse(double lat, double lon)
        {
            Dictionary<string, object> d = GetJson("https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=10&accept-language=en&lat=" +
                                                   F(lat) + "&lon=" + F(lon));
            if (d == null || d.ContainsKey("error")) return null;
            var a = d.ContainsKey("address") ? d["address"] as Dictionary<string, object> : null;
            string name = First(a, "city", "town", "village", "municipality", "county", "state_district", "state");
            if (name.Length == 0) name = Str(d, "name");
            if (name.Length == 0) return null;
            return new Place(lat, lon, name, Join(name, Str(a, "state"), Str(a, "country")), "");
        }

        public static double Km(double aLat, double aLon, double bLat, double bLon)
        {
            double r = Math.PI / 180, dLat = (bLat - aLat) * r, dLon = (bLon - aLon) * r;
            double s = Math.Pow(Math.Sin(dLat / 2), 2) + Math.Cos(aLat * r) * Math.Cos(bLat * r) * Math.Pow(Math.Sin(dLon / 2), 2);
            return 6371 * 2 * Math.Asin(Math.Min(1, Math.Sqrt(s)));
        }

        public static string F(double v) { return v.ToString("0.####", CultureInfo.InvariantCulture); }

        public static string Coords(double lat, double lon)
        {
            return Math.Abs(lat).ToString("0.00", CultureInfo.InvariantCulture) + "° " + (lat >= 0 ? "N" : "S") + ", " +
                   Math.Abs(lon).ToString("0.00", CultureInfo.InvariantCulture) + "° " + (lon >= 0 ? "E" : "W");
        }

        private static Dictionary<string, object> GetJson(string url)
        {
            var req = (HttpWebRequest)WebRequest.Create(url);
            req.UserAgent = Agent;
            req.Accept = "application/json";
            req.Timeout = 8000;
            req.ReadWriteTimeout = 8000;
            // gzip only: .NET Framework misreads the zlib-wrapped "deflate" some servers send
            req.AutomaticDecompression = DecompressionMethods.GZip;
            using (var res = (HttpWebResponse)req.GetResponse())
            using (var rd = new StreamReader(res.GetResponseStream(), Encoding.UTF8))
                return new JavaScriptSerializer().DeserializeObject(rd.ReadToEnd()) as Dictionary<string, object>;
        }

        private static string Str(Dictionary<string, object> d, string key)
        {
            object o;
            return d != null && d.TryGetValue(key, out o) && o != null ? o.ToString().Trim() : "";
        }

        private static string First(Dictionary<string, object> d, params string[] keys)
        {
            foreach (string k in keys)
            {
                string s = Str(d, k);
                if (s.Length > 0) return s;
            }
            return "";
        }

        private static double Num(Dictionary<string, object> d, string key)
        {
            object o;
            if (d == null || !d.TryGetValue(key, out o) || o == null) return double.NaN;
            double v;
            if (o is string) return double.TryParse((string)o, NumberStyles.Float, CultureInfo.InvariantCulture, out v) ? v : double.NaN;
            try { return Convert.ToDouble(o, CultureInfo.InvariantCulture); }
            catch (Exception) { return double.NaN; }
        }

        private static string Join(params string[] parts)
        {
            var seen = new List<string>();
            foreach (string p in parts)
                if (!string.IsNullOrEmpty(p) && !seen.Contains(p)) seen.Add(p);
            return string.Join(", ", seen.ToArray());
        }
    }

    // ====================================================================== the app
    internal sealed class Host : ApplicationContext
    {
        private const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";
        private const string RunValue = "LivingEarth";

        private const int BusyPercent = 65;        // whole-PC CPU that counts as "the PC is working hard"
        private const int BusySeconds = 3;         // ...for this long, so a short spike doesn't count
        private const int BusyHoldSeconds = 20;    // stay at the slow pace this long after the CPU calms down
        private const int WakeQuietSeconds = 20;   // after the PC wakes, no frames for this long: the graphics card and the
                                                   // lock screen have the screens to themselves while they come back
        private const int SignInMinSeconds = 15;   // at sign-in, wait at least this long before starting the scene...
        private const int SignInMaxSeconds = 90;   // ...and then for 3 calm seconds in a row, but no longer than this
        private const int AttachTimeoutSeconds = 60;
        private const int QuickDeathSeconds = 30;  // Edge going away sooner than this counts as failing to start
        private const int MaxQuickDeaths = 3;      // ...and this many in a row stops the trying, so the screen can't keep flashing

        // The pace the page understands: see src/services/host.js
        private const string Live = "live", Rest = "rest", Still = "still";

        internal static readonly Icon AppIcon = DrawIcon();

        private readonly string hostDir;
        private readonly string pagePath;
        private readonly string statePath;
        private readonly string dataDir;
        private readonly string settingsPath;
        private readonly string logPath;
        private readonly string extraEdgeArgs = "";
        private readonly string queryOverride;     // tests: the exact page address, and nothing saved
        private readonly bool saveSettings = true;
        private Settings settings;

        private readonly System.Windows.Forms.Timer timer;
        private readonly NotifyIcon tray;
        private readonly ToolStripMenuItem statusItem, desktopItem, maximizedItem, pausedItem, startupItem, demoItem;
        private readonly Control invoker;
        private readonly EventWaitHandle showEvent;
        private readonly RegisteredWaitHandle showWait;
        private readonly int ownPid = Process.GetCurrentProcess().Id;
        private SetupForm setup;
        private bool running, quitting, detecting, toldUnsupported;
        private bool demo; // the demo is playing: a year in two minutes. Not saved
        private DateTime nextDetect = DateTime.MinValue;

        private IntPtr job, edgeProcess, wallpaper, progman, iconView, workerW, focusBeforeLaunch;
        private DateTime startedAt, nextLaunch = DateTime.MinValue;
        private TimeSpan backoff = TimeSpan.FromSeconds(5);
        private bool attached, handedOver, locked, desktopInFront = true;
        private DateTime quietUntil = DateTime.MinValue; // no frames before this: going to sleep, or just woken
        private int placeTick, quickDeaths, reorders, placeEvery;
        private readonly WindowsBackground background; // null in tests, which must never change the real one
        private DateTime nextBackground = DateTime.MinValue;

        private long lastIdle, lastKernel, lastUser;
        private int busyFor;
        private DateTime busyUntil = DateTime.MinValue;
        private string written;

        /// <summary>
        /// The page inside this exe, unpacked into a folder under dir named after its contents, so an updated exe
        /// brings its own page. Returns that folder, or null if this build carries no page.
        /// </summary>
        internal static string UnpackPage(string dir)
        {
            using (Stream s = Assembly.GetExecutingAssembly().GetManifestResourceStream("page.zip"))
            {
                if (s == null) return null;
                string tag;
                using (var sha = SHA256.Create()) tag = BitConverter.ToString(sha.ComputeHash(s)).Replace("-", "").Substring(0, 12);
                s.Position = 0;
                string page = Path.Combine(dir, "page-" + tag);
                string done = Path.Combine(page, "unpacked");
                if (!File.Exists(done))
                {
                    if (Directory.Exists(page)) Directory.Delete(page, true);
                    using (var zip = new ZipArchive(s, ZipArchiveMode.Read)) zip.ExtractToDirectory(page);
                    File.WriteAllText(done, "");
                }
                foreach (string old in Directory.GetDirectories(dir, "page-*"))
                {
                    if (string.Equals(old, page, StringComparison.OrdinalIgnoreCase)) continue;
                    try { Directory.Delete(old, true); }
                    catch (IOException) { } // still in use by a running copy: next time
                    catch (UnauthorizedAccessException) { }
                }
                return page;
            }
        }

        public Host(string[] args)
        {
            dataDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "LivingEarth");
            Directory.CreateDirectory(dataDir);
            hostDir = AppDomain.CurrentDomain.BaseDirectory;
            pagePath = Path.GetFullPath(Path.Combine(hostDir, "..", "index.html"));
            if (!File.Exists(Path.GetFullPath(Path.Combine(hostDir, "..", "src", "main.js"))))
            {
                // Downloaded on its own: the page is inside this exe
                string page = null;
                try { page = UnpackPage(dataDir); }
                catch (IOException) { }
                catch (UnauthorizedAccessException) { }
                catch (InvalidDataException) { }
                if (page == null)
                {
                    MessageBox.Show("Living Earth Himalaya could not unpack its files into\n" + dataDir + "\n\nCheck that the disk has free space, then try again.",
                        "Living Earth Himalaya", MessageBoxButtons.OK, MessageBoxIcon.Error);
                    Environment.Exit(1);
                }
                hostDir = Path.Combine(page, "host");
                pagePath = Path.Combine(page, "index.html");
            }
            statePath = Path.Combine(hostDir, "state.js");
            settingsPath = Path.Combine(dataDir, "settings.ini");
            logPath = Path.Combine(dataDir, "host.log");
            // Starting again is what people do after a failure: keep the logs of the runs before (three, because a restart
            // with the power button and then another start used to overwrite the one that showed what went wrong)
            try
            {
                string last = logPath + ".previous", second = last + "-2", third = last + "-3";
                if (File.Exists(second)) File.Copy(second, third, true);
                if (File.Exists(last)) File.Copy(last, second, true);
                if (File.Exists(logPath)) File.Copy(logPath, last, true);
            }
            catch (IOException) { }
            catch (UnauthorizedAccessException) { }
            File.WriteAllText(logPath, "");
            LogStart(args);
            settings = Settings.Load(settingsPath);

            bool silent = false, atSignIn = false;
            foreach (string a in args)
            {
                if (a == "--startup") silent = atSignIn = true;
                else if (a.StartsWith("--mode=")) { settings.Mode = Settings.ParseMode(a.Substring(7)); saveSettings = false; silent = true; }
                else if (a.StartsWith("--query=")) { queryOverride = a.Substring(8); saveSettings = false; silent = true; }
                else if (a.StartsWith("--edge-arg=")) { extraEdgeArgs += " " + a.Substring(11); }
            }
            if (saveSettings) background = new WindowsBackground(Path.Combine(hostDir, "stills"), dataDir, Log);

            invoker = new Control();
            invoker.CreateControl();
            GC.KeepAlive(invoker.Handle); // calls from other threads come back to this one through it

            var menu = new ContextMenuStrip();
            statusItem = new ToolStripMenuItem("Starting...") { Enabled = false };
            var settingsItem = new ToolStripMenuItem("Settings...", null, delegate { ShowSetup(); });
            settingsItem.Font = new Font(settingsItem.Font, FontStyle.Bold);
            demoItem = new ToolStripMenuItem("Play the demo: a year in two minutes", null, delegate { SetDemo(!demo); });
            desktopItem = ModeItem("Animate only on the empty desktop (lightest)", RestMode.Desktop);
            maximizedItem = ModeItem("Animate unless a window is maximized", RestMode.Maximized);
            pausedItem = ModeItem("Pause (keep the current picture)", RestMode.Paused);
            startupItem = new ToolStripMenuItem("Start with Windows", null, delegate { SetStartup(!StartsWithWindows()); }) { Checked = StartsWithWindows() };
            var aboutItem = new ToolStripMenuItem("About Living Earth Himalaya", null, delegate { AboutForm.ShowOnce(); });
            menu.Items.AddRange(new ToolStripItem[]
            {
                statusItem, new ToolStripSeparator(), settingsItem, demoItem, new ToolStripSeparator(), desktopItem, maximizedItem, pausedItem,
                new ToolStripSeparator(), startupItem, aboutItem, new ToolStripMenuItem("Exit (back to the normal wallpaper)", null, delegate { Quit(); })
            });
            tray = new NotifyIcon { Icon = AppIcon, Text = "Living Earth Himalaya", ContextMenuStrip = menu, Visible = false };
            tray.DoubleClick += delegate { ShowSetup(); };
            ShowMode();

            // A second copy of the app (opened from Explorer or the Start menu) asks this one to show its window
            showEvent = new EventWaitHandle(false, EventResetMode.AutoReset, Program.ShowEventName);
            showWait = ThreadPool.RegisterWaitForSingleObject(showEvent, delegate
            {
                try { invoker.BeginInvoke(new MethodInvoker(ShowSetup)); }
                catch (InvalidOperationException) { }
            }, null, -1, false);

            // An older entry without --startup would open the window at every sign-in
            if (StartsWithWindows() && !RunCommand().Contains("--startup")) SetStartup(true);

            SystemEvents.SessionSwitch += OnSessionSwitch;
            SystemEvents.DisplaySettingsChanged += OnDisplayChanged;
            SystemEvents.PowerModeChanged += OnPowerModeChanged;

            timer = new System.Windows.Forms.Timer { Interval = 1000 };
            timer.Tick += OnTick;

            // After the message loop starts, so that quitting from here ends it
            invoker.BeginInvoke(new MethodInvoker(delegate
            {
                if (atSignIn) StartWhenSettled();
                else if (silent) StartWallpaper();
                else ShowSetup();
            }));
        }

        // ------------------------------------------------------------------ the setup window
        private void ShowSetup()
        {
            if (quitting) return;
            if (setup != null && !setup.IsDisposed)
            {
                if (setup.WindowState == FormWindowState.Minimized) setup.WindowState = FormWindowState.Normal;
                setup.Activate();
                return;
            }
            setup = new SetupForm(settings.Copy(), StartsWithWindows(), Path.Combine(hostDir, "banner.jpg"));
            setup.FormClosed += OnSetupClosed;
            setup.Show();
            setup.Activate();
        }

        private void OnSetupClosed(object sender, FormClosedEventArgs e)
        {
            var form = (SetupForm)sender;
            setup = null;
            if (quitting) return;
            if (form.DialogResult != DialogResult.OK)
            {
                if (!running) Quit(); // closed before the wallpaper was ever set
                return;
            }
            bool hadBackground = settings.WindowsBackground;
            settings = form.Result;
            if (form.DetectedNow) nextDetect = DateTime.UtcNow.AddMinutes(30);
            SaveSettings();
            SetStartup(form.StartWithWindows);
            ShowMode();
            Place p = settings.Current;
            Log("settings: " + settings.Mode + ", quality " + settings.Quality + ", " +
                (p == null ? "default place" : p.Detail + (settings.AutoLocation ? " (automatic)" : " (chosen)")) +
                ", road " + (settings.Road ? "on, " + settings.Traffic + " traffic" : "off") + ", birds " + (settings.Birds ? "on" : "off") +
                ", leaves " + (settings.Leaves ? "on" : "off") + ", tree " + (settings.Tree ? "on" : "off") +
                ", mist " + (settings.Mist ? "on" : "off") + ", peak clouds " + (settings.Banners ? "on" : "off") + ", smoke " + (settings.Smoke ? "on" : "off") +
                ", fires " + (settings.Fires ? "on" : "off") + ", village lights " + (settings.Lights ? "on" : "off") +
                ", shooting stars " + (settings.Stars ? "on" : "off") +
                ", panel " + (settings.Panel ? settings.Corner + " " + settings.PanelSize : "hidden") +
                ", Windows background " + (settings.WindowsBackground ? "on" : "off"));
            if (background != null && hadBackground && !settings.WindowsBackground && background.Restore()) PlaceSoon();
            nextBackground = DateTime.MinValue; // the place may have changed, and with it the sun
            if (form.DemoRequested) SetDemo(true);
            if (!running) StartWallpaper(); // otherwise the page picks the change up from state.js within a second
        }

        // The demo: the page plays a year in two minutes while this is on. It reaches the page through state.js.
        private void SetDemo(bool on)
        {
            demo = on;
            demoItem.Checked = on;
            Log(on ? "demo: playing a year in two minutes" : "demo: off, back to the real time and weather");
            if (!running) StartWallpaper();
        }

        // ------------------------------------------------------------------ start
        private void StartWallpaper()
        {
            if (running || quitting) return;
            if (DesktopLayout() == Layout.Unsupported)
            {
                TellUnsupported();
                return;
            }
            running = true;
            tray.Visible = true;
            SampleCpu();
            WriteState(Live);
            timer.Start();
            OnTick(null, EventArgs.Empty);
        }

        // At sign-in Windows starts everything at once. The scene waits until the PC has settled, so the desktop and the
        // apps that start with Windows come up as quickly as they would without it.
        private void StartWhenSettled()
        {
            DateTime began = DateTime.UtcNow;
            int calm = 0;
            SampleCpu();
            var wait = new System.Windows.Forms.Timer { Interval = 1000 };
            wait.Tick += delegate
            {
                double waited = (DateTime.UtcNow - began).TotalSeconds;
                calm = SampleCpu() < BusyPercent ? calm + 1 : 0;
                bool done = quitting || running; // started from the window meanwhile, or quit
                if (!done && waited < SignInMinSeconds) return;
                if (!done && calm < 3 && waited < SignInMaxSeconds) return;
                wait.Stop();
                wait.Dispose();
                if (done) return;
                Log(string.Format("sign-in: starting after {0:0} s{1}", waited, calm >= 3 ? ", the PC has settled" : ", the PC is still busy"));
                StartWallpaper();
            };
            wait.Start();
        }

        private void TellUnsupported()
        {
            if (toldUnsupported) return;
            toldUnsupported = true;
            Log("desktop layout not recognized: this app needs Windows 11 24H2 or later");
            StopEdge();
            MessageBox.Show(
                "Living Earth Himalaya can only put itself behind the desktop icons on Windows 11 version 24H2 or later.\n\n" +
                "On this version of Windows, use the free Lively Wallpaper app with the Lively download instead. " +
                "The project page on GitHub explains how.",
                "Living Earth Himalaya", MessageBoxButtons.OK, MessageBoxIcon.Information);
            Quit();
        }

        // ------------------------------------------------------------------ the one-second loop
        private void OnTick(object sender, EventArgs e)
        {
            try
            {
                DateTime now = DateTime.UtcNow;
                KeepEdgeRunning(now);
                if (quitting) return;
                string pace = DecidePace(now);
                WriteState(pace);
                if (now >= nextBackground) UpdateBackground(now);
                if (settings.AutoLocation && !detecting && now >= nextDetect) DetectLocation();
                string status = !attached ? "Starting..." : pace == Live ? "Animating" : pace == Rest ? "Slow updates" : "Paused";
                if (statusItem.Text != "Living Earth Himalaya: " + status) statusItem.Text = "Living Earth Himalaya: " + status;
            }
            catch (Exception ex)
            {
                Log("tick: " + ex.Message);
            }
        }

        // Windows' own background: the still for where the sun is now, checked every minute. Setting it makes Explorer
        // put a new layer in front of this wallpaper, so the window goes back on top every second for a while after.
        private void UpdateBackground(DateTime now)
        {
            nextBackground = now.AddMinutes(1);
            if (background == null || !settings.WindowsBackground || locked) return;
            Place p = settings.Current;
            // with no place yet, the page's default: Dhaka
            string still = WindowsBackground.StillFor(now, p != null ? p.Lat : 23.7104, p != null ? p.Lon : 90.4074);
            if (background.Show(still, SystemInformation.MonitorCount > 1)) PlaceSoon();
        }

        private void PlaceSoon()
        {
            placeEvery = 15;
        }

        // Every 30 minutes, so a laptop that travels gets its own sky. No prompt: that only comes from the window.
        private async void DetectLocation()
        {
            detecting = true;
            Place p = null;
            try { p = await Locator.DetectAsync(settings.Detected, false); }
            catch (Exception ex) { Log("location: " + ex.Message); }
            detecting = false;
            if (quitting) return;
            if (p == null)
            {
                nextDetect = DateTime.UtcNow.AddMinutes(5);
                return;
            }
            nextDetect = DateTime.UtcNow.AddMinutes(30);
            Place old = settings.Detected;
            if (old != null && old.Name == p.Name && Locator.Km(old.Lat, old.Lon, p.Lat, p.Lon) < 1) return;
            settings.Detected = p;
            Log("location: " + p.Detail + ", from " + p.Source);
            SaveSettings();
        }

        private string DecidePace(DateTime now)
        {
            if (SampleCpu() >= BusyPercent) busyFor++;
            else busyFor = 0;
            if (busyFor >= BusySeconds)
            {
                if (now >= busyUntil) Log("PC busy: slow updates until the CPU calms down");
                busyUntil = now.AddSeconds(BusyHoldSeconds);
            }

            RestMode mode = settings.Mode;
            if (mode == RestMode.Always) return Live;
            if (mode == RestMode.Paused || locked || now < quietUntil) return Still;
            if (now < busyUntil) return Rest;

            if (mode == RestMode.Maximized) return ForegroundCoversScreen() ? Rest : Live;
            bool? inFront = DesktopInFront();
            if (inFront.HasValue) desktopInFront = inFront.Value;
            return desktopInFront ? Live : Rest;
        }

        private int SampleCpu()
        {
            long idle, kernel, user;
            if (!Native.GetSystemTimes(out idle, out kernel, out user)) return 0;
            long total = (kernel - lastKernel) + (user - lastUser); // kernel time includes idle time
            long busy = total - (idle - lastIdle);
            lastIdle = idle; lastKernel = kernel; lastUser = user;
            return total > 0 ? (int)(100 * busy / total) : 0;
        }

        // null means the taskbar or system UI has focus, which shouldn't change the decision.
        private bool? DesktopInFront()
        {
            IntPtr fg = Native.GetForegroundWindow();
            if (fg == IntPtr.Zero || PidOf(fg) == ownPid) return null;
            switch (ClassOf(fg))
            {
                case "Progman":
                case "WorkerW":
                    return true;
                case "Shell_TrayWnd":
                case "Shell_SecondaryTrayWnd":
                case "NotifyIconOverflowWindow":
                case "TopLevelWindowForOverflowXamlIsland":
                case "XamlExplorerHostIslandWindow":
                    return null;
                default:
                    return false;
            }
        }

        private bool ForegroundCoversScreen()
        {
            IntPtr fg = Native.GetForegroundWindow();
            if (fg == IntPtr.Zero) return false;
            string cls = ClassOf(fg);
            if (cls == "Progman" || cls == "WorkerW" || cls == "Shell_TrayWnd" || cls == "Shell_SecondaryTrayWnd") return false;
            if (Native.IsZoomed(fg)) return true;
            Native.RECT r;
            if (!Native.GetWindowRect(fg, out r)) return false;
            Rectangle s = Screen.FromHandle(fg).Bounds;
            return r.Left <= s.Left && r.Top <= s.Top && r.Right >= s.Right && r.Bottom >= s.Bottom;
        }

        private void WriteState(string pace)
        {
            var js = new StringBuilder("window.leHostState && window.leHostState('").Append(pace).Append('\'');
            if (queryOverride == null)
            {
                js.Append(", { quality: ").Append(Js(settings.Quality));
                js.Append(", road: ").Append(settings.Road ? "true" : "false");
                js.Append(", traffic: ").Append(Js(settings.Traffic));
                js.Append(", birds: ").Append(settings.Birds ? "true" : "false");
                js.Append(", leaves: ").Append(settings.Leaves ? "true" : "false");
                js.Append(", tree: ").Append(settings.Tree ? "true" : "false");
                js.Append(", mist: ").Append(settings.Mist ? "true" : "false");
                js.Append(", banners: ").Append(settings.Banners ? "true" : "false");
                js.Append(", demo: ").Append(demo ? "true" : "false");
                js.Append(", smoke: ").Append(settings.Smoke ? "true" : "false");
                js.Append(", fires: ").Append(settings.Fires ? "true" : "false");
                js.Append(", lights: ").Append(settings.Lights ? "true" : "false");
                js.Append(", stars: ").Append(settings.Stars ? "true" : "false");
                js.Append(", panel: ").Append(settings.Panel ? "true" : "false");
                js.Append(", corner: ").Append(Js(settings.Corner));
                js.Append(", panelSize: ").Append(Js(settings.PanelSize));
                Place p = settings.Current;
                if (p != null)
                    js.Append(", place: { lat: ").Append(Locator.F(p.Lat)).Append(", lon: ").Append(Locator.F(p.Lon))
                      .Append(", name: ").Append(Js(p.Name)).Append(" }");
                js.Append(" }");
            }
            js.Append(");\n");
            string text = js.ToString();
            if (written == text) return;
            string tmp = statePath + ".tmp";
            try
            {
                File.WriteAllText(tmp, text);
                if (File.Exists(statePath)) File.Replace(tmp, statePath, null);
                else File.Move(tmp, statePath);
                written = text;
            }
            catch (IOException)
            {
                // Edge may be reading the file at this moment: the next tick tries again
            }
            catch (UnauthorizedAccessException)
            {
                // same as above
            }
        }

        /** A JavaScript string with everything but plain letters, digits and spaces escaped. */
        private static string Js(string s)
        {
            var b = new StringBuilder("'");
            foreach (char c in s)
            {
                if (c < 128 && (char.IsLetterOrDigit(c) || c == ' ' || c == ',' || c == '.' || c == '-')) b.Append(c);
                else b.Append("\\u").Append(((int)c).ToString("x4"));
            }
            return b.Append('\'').ToString();
        }

        private string PageQuery()
        {
            if (queryOverride != null) return queryOverride;
            var q = new StringBuilder("quality=").Append(settings.Quality).Append("&fps=24&geo=0");
            if (!settings.Road) q.Append("&road=0");
            q.Append("&traffic=").Append(settings.Traffic);
            if (!settings.Birds) q.Append("&birds=0");
            if (!settings.Leaves) q.Append("&leaves=0");
            if (!settings.Tree) q.Append("&tree=0");
            if (!settings.Mist) q.Append("&mist=0");
            if (!settings.Banners) q.Append("&banners=0");
            if (!settings.Smoke) q.Append("&smoke=0");
            if (!settings.Fires) q.Append("&fires=0");
            if (!settings.Lights) q.Append("&lights=0");
            if (!settings.Stars) q.Append("&stars=0");
            if (!settings.Panel) q.Append("&panel=0");
            q.Append("&corner=").Append(settings.Corner);
            q.Append("&panelsize=").Append(settings.PanelSize);
            Place p = settings.Current;
            if (p != null)
                q.Append("&lat=").Append(Locator.F(p.Lat)).Append("&lon=").Append(Locator.F(p.Lon))
                 .Append("&place=").Append(Uri.EscapeDataString(p.Name));
            return q.ToString();
        }

        // ------------------------------------------------------------------ Edge
        private void KeepEdgeRunning(DateTime now)
        {
            bool alive = edgeProcess != IntPtr.Zero && EdgeRunning();
            if (alive && attached && !Native.IsWindow(wallpaper)) alive = false; // Explorer restarted

            if (!alive)
            {
                if (edgeProcess != IntPtr.Zero && EdgeFailed(now, "Edge or its window went away (" + DescribeEdgeExit() + ")")) return;
                if (now >= nextLaunch) StartEdge(now);
                return;
            }

            if (!attached)
            {
                if (TryAttach())
                {
                    attached = true;
                    Log("attached behind the desktop icons (window of process " + PidOf(wallpaper) + ")");
                    // Kiosk mode can take focus as it opens: give it back to what you were using
                    if (Native.IsWindow(focusBeforeLaunch)) Native.SetForegroundWindow(focusBeforeLaunch);
                }
                else if ((now - startedAt).TotalSeconds > AttachTimeoutSeconds)
                {
                    EdgeFailed(now, "could not attach within " + AttachTimeoutSeconds + " s");
                }
                return;
            }

            if (placeEvery > 0) placeEvery--;
            if (++placeTick % 5 == 0 || placeEvery > 0) Place(false);
            if ((now - startedAt).TotalMinutes > 5) backoff = TimeSpan.FromSeconds(5);
        }

        // The process this app starts isn't always the browser: it can hand over to a second msedge.exe moments after it
        // starts, and then exit normally. Windows brings this on the first time it sees a new exe, and it would happen again
        // on every start of that run. So what counts is the job, which holds whichever process is the browser.
        private bool EdgeRunning()
        {
            if (Native.WaitForSingleObject(edgeProcess, 0) != 0) return true;
            int started, active, overLimit;
            if (!JobCounts(out started, out active, out overLimit) || active == 0) return false;
            if (!handedOver)
            {
                handedOver = true;
                Log("Edge handed over to a new process (" + DescribeEdgeExit() + ")");
            }
            return true;
        }

        // Returns true if this stopped the trying.
        private bool EdgeFailed(DateTime now, string what)
        {
            // Lasting a while and then going away (Explorer restarted, say) isn't the same as being unable to start
            quickDeaths = !attached || (now - startedAt).TotalSeconds < QuickDeathSeconds ? quickDeaths + 1 : 0;
            bool giveUp = quickDeaths >= MaxQuickDeaths;
            Log(what + (giveUp ? "" : ", restarting in " + backoff.TotalSeconds + " s"));
            StopEdge();
            nextLaunch = now + backoff;
            backoff = TimeSpan.FromSeconds(Math.Min(backoff.TotalSeconds * 2, 300));
            if (!giveUp) return false;

            Log("stopped trying after " + quickDeaths + " failed starts in a row");
            running = false;
            timer.Stop();
            quickDeaths = 0;
            backoff = TimeSpan.FromSeconds(5);
            nextLaunch = DateTime.MinValue;
            MessageBox.Show(
                "Microsoft Edge closed right after it opened, " + MaxQuickDeaths + " times in a row, so the wallpaper could not start.\n\n" +
                "Click Set wallpaper to try again, or close the window to keep your normal wallpaper.\n\nDetails are in " + logPath,
                "Living Earth Himalaya", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            if (!quitting) ShowSetup();
            return true;
        }

        private void StartEdge(DateTime now)
        {
            string edge = FindEdge();
            if (edge == null)
            {
                Log("Edge not found");
                if (nextLaunch == DateTime.MinValue)
                    tray.ShowBalloonTip(10000, "Living Earth Himalaya", "Microsoft Edge was not found. Living Earth Himalaya uses it to draw the wallpaper.", ToolTipIcon.Warning);
                nextLaunch = now.AddMinutes(5);
                return;
            }

            string url = new Uri(pagePath).AbsoluteUri + "?host=1&" + PageQuery();
            Rectangle vs = SystemInformation.VirtualScreen;
            var cmd = new StringBuilder();
            cmd.Append('"').Append(edge).Append('"');
            // Kiosk mode, because an --app window keeps a title bar that Edge draws inside the window itself.
            cmd.Append(" --kiosk \"").Append(url).Append("\" --edge-kiosk-type=fullscreen");
            cmd.Append(" --user-data-dir=\"").Append(Path.Combine(dataDir, "edge-profile")).Append('"');
            cmd.Append(" --window-position=").Append(vs.X).Append(',').Append(vs.Y);
            cmd.Append(" --window-size=").Append(vs.Width).Append(',').Append(vs.Height);
            cmd.Append(" --no-first-run --no-default-browser-check --hide-crash-restore-bubble");
            cmd.Append(" --disable-extensions --disable-sync --disable-background-networking");
            cmd.Append(" --disable-component-update --disable-default-apps");
            // Never fall back to drawing on the CPU: an error on the wallpaper is better than a saturated PC.
            cmd.Append(" --disable-software-rasterizer");
            // At below-normal priority a busy PC could otherwise make the GPU process look hung.
            cmd.Append(" --disable-gpu-watchdog");
            // A window behind the icons must keep running, and this app decides when it rests.
            cmd.Append(" --disable-features=CalculateNativeWinOcclusion");
            cmd.Append(" --disable-renderer-backgrounding --disable-background-timer-throttling");
            cmd.Append(" --disable-backgrounding-occluded-windows");
            // Never --enable-logging: started from an app without a console, as this is, Edge then opens a console window of its own.
            cmd.Append(extraEdgeArgs);

            CreateJob();
            focusBeforeLaunch = Native.GetForegroundWindow();
            var si = new Native.STARTUPINFO();
            si.cb = Marshal.SizeOf(si);
            si.dwFlags = Native.STARTF_USESHOWWINDOW;
            si.wShowWindow = Native.SW_SHOWMINNOACTIVE;
            Native.PROCESS_INFORMATION pi;
            uint flags = Native.CREATE_SUSPENDED | Native.BELOW_NORMAL_PRIORITY_CLASS;
            if (!Native.CreateProcess(null, cmd.ToString(), IntPtr.Zero, IntPtr.Zero, false, flags, IntPtr.Zero, null, ref si, out pi))
            {
                Log("could not start Edge: " + Marshal.GetLastWin32Error());
                nextLaunch = now.AddMinutes(1);
                return;
            }
            if (!Native.AssignProcessToJobObject(job, pi.hProcess)) Log("job assignment failed: " + Marshal.GetLastWin32Error());
            Native.ResumeThread(pi.hThread);
            Native.CloseHandle(pi.hThread);
            edgeProcess = pi.hProcess;
            startedAt = now;
            handedOver = false;
            attached = false;
            wallpaper = IntPtr.Zero;
            written = null; // the new page needs the current state
            // If Explorer restarted, its tray forgot this icon
            tray.Visible = false;
            tray.Visible = true;
            Log("started Edge: " + url + " (in front: " + DescribeWindow(focusBeforeLaunch) + ")");
        }

        // ------------------------------------------------------------------ what the log needs after a failure
        private void LogStart(string[] args)
        {
            bool inJob;
            bool known = Native.IsProcessInJob(Native.GetCurrentProcess(), IntPtr.Zero, out inJob);
            string layer = Environment.GetEnvironmentVariable("__COMPAT_LAYER");
            Log("app started: " + Assembly.GetExecutingAssembly().GetName().Version + ", pid " + ownPid +
                (known ? (inJob ? ", in a job" : ", not in a job") : "") + ", args [" + string.Join(" ", args) + "]" +
                (string.IsNullOrEmpty(layer) ? "" : ", compatibility layer " + layer));
        }

        private bool JobCounts(out int started, out int active, out int overLimit)
        {
            started = active = overLimit = 0;
            if (job == IntPtr.Zero) return false;
            const int Size = 48; // JOBOBJECT_BASIC_ACCOUNTING_INFORMATION
            IntPtr mem = Marshal.AllocHGlobal(Size);
            try
            {
                uint got;
                if (!Native.QueryInformationJobObject(job, Native.JobObjectBasicAccountingInformation, mem, Size, out got)) return false;
                started = Marshal.ReadInt32(mem, 36);
                active = Marshal.ReadInt32(mem, 40);
                overLimit = Marshal.ReadInt32(mem, 44);
                return true;
            }
            finally
            {
                Marshal.FreeHGlobal(mem);
            }
        }

        private bool InEdgeJob(int pid)
        {
            IntPtr p = Native.OpenProcess(Native.PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
            if (p == IntPtr.Zero) return false;
            try
            {
                bool inJob;
                return Native.IsProcessInJob(p, job, out inJob) && inJob;
            }
            finally
            {
                Native.CloseHandle(p);
            }
        }

        private string DescribeWindow(IntPtr h)
        {
            if (h == IntPtr.Zero) return "nothing";
            int pid = PidOf(h);
            if (pid == ownPid) return "this app";
            try { using (Process p = Process.GetProcessById(pid)) return p.ProcessName + "/" + ClassOf(h); }
            catch (ArgumentException) { return ClassOf(h); }
            catch (InvalidOperationException) { return ClassOf(h); }
        }

        // Exit code, how long it lived, and what is still alive in its job: what tells a crash, a kill and a relaunch apart.
        private string DescribeEdgeExit()
        {
            var s = new StringBuilder();
            uint code;
            bool exited = Native.GetExitCodeProcess(edgeProcess, out code) && code != Native.STILL_ACTIVE;
            s.Append(exited ? "exit code 0x" + code.ToString("X") : "main process still running");
            long created, ended, kernel, user;
            if (exited && Native.GetProcessTimes(edgeProcess, out created, out ended, out kernel, out user))
                s.Append(", lived ").Append((ended - created) / 10000).Append(" ms");
            int started, active, overLimit;
            if (JobCounts(out started, out active, out overLimit))
                s.Append(", job: ").Append(started).Append(" started, ").Append(active).Append(" alive, ").Append(overLimit).Append(" over a limit");
            return s.ToString();
        }

        private void StopEdge()
        {
            if (job != IntPtr.Zero)
            {
                Native.TerminateJobObject(job, 0);
                Native.CloseHandle(job);
                job = IntPtr.Zero;
            }
            if (edgeProcess != IntPtr.Zero)
            {
                Native.CloseHandle(edgeProcess);
                edgeProcess = IntPtr.Zero;
            }
            attached = false;
            wallpaper = IntPtr.Zero;
        }

        private void CreateJob()
        {
            job = Native.CreateJobObject(IntPtr.Zero, null);
            var info = new Native.JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
            info.BasicLimitInformation.LimitFlags = Native.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | Native.JOB_OBJECT_LIMIT_PRIORITY_CLASS;
            info.BasicLimitInformation.PriorityClass = Native.BELOW_NORMAL_PRIORITY_CLASS;
            int size = Marshal.SizeOf(info);
            IntPtr mem = Marshal.AllocHGlobal(size);
            try
            {
                Marshal.StructureToPtr(info, mem, false);
                if (!Native.SetInformationJobObject(job, Native.JobObjectExtendedLimitInformation, mem, (uint)size))
                    Log("job setup failed: " + Marshal.GetLastWin32Error());
            }
            finally
            {
                Marshal.FreeHGlobal(mem);
            }
        }

        private static string FindEdge()
        {
            using (RegistryKey k = Registry.LocalMachine.OpenSubKey(@"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\msedge.exe"))
            {
                string p = k == null ? null : k.GetValue(null) as string;
                if (!string.IsNullOrEmpty(p) && File.Exists(p)) return p;
            }
            string fallback = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), @"Microsoft\Edge\Application\msedge.exe");
            return File.Exists(fallback) ? fallback : null;
        }

        // ------------------------------------------------------------------ behind the icons
        // Windows 11 24H2 and later keep the icons and the wallpaper layer side by side under Progman:
        //   Progman → SHELLDLL_DefView (icons), [the wallpaper goes here], WorkerW
        private bool FindDesktop()
        {
            progman = Native.FindWindow("Progman", null);
            if (progman == IntPtr.Zero) return false;
            IntPtr r;
            // Asks Explorer to create the wallpaper layer. It ignores the request if the layer exists.
            Native.SendMessageTimeout(progman, 0x052C, new IntPtr(0xD), new IntPtr(1), 0, 1000, out r);
            Native.SendMessageTimeout(progman, 0x052C, IntPtr.Zero, IntPtr.Zero, 0, 1000, out r);
            FindLayers();
            return iconView != IntPtr.Zero;
        }

        private void FindLayers()
        {
            iconView = Native.FindWindowEx(progman, IntPtr.Zero, "SHELLDLL_DefView", null);
            workerW = Native.FindWindowEx(progman, IntPtr.Zero, "WorkerW", null);
        }

        private enum Layout { Ready, NotYet, Unsupported }

        // NotYet: Explorer is still starting (at sign-in). Unsupported: an older Windows, whose desktop icons
        // sit in a separate top-level WorkerW window.
        private Layout DesktopLayout()
        {
            if (FindDesktop()) return Layout.Ready;
            if (progman == IntPtr.Zero) return Layout.NotYet;
            IntPtr w = IntPtr.Zero;
            while ((w = Native.FindWindowEx(IntPtr.Zero, w, "WorkerW", null)) != IntPtr.Zero)
                if (Native.FindWindowEx(w, IntPtr.Zero, "SHELLDLL_DefView", null) != IntPtr.Zero) return Layout.Unsupported;
            return Layout.NotYet;
        }

        private bool TryAttach()
        {
            IntPtr win = FindEdgeWindow();
            if (win == IntPtr.Zero) return false;
            Layout layout = DesktopLayout();
            if (layout == Layout.Unsupported)
            {
                TellUnsupported();
                return false;
            }
            if (layout != Layout.Ready) return false;

            int style = Native.GetWindowLong(win, Native.GWL_STYLE);
            style &= ~(Native.WS_POPUP | Native.WS_CAPTION | Native.WS_THICKFRAME | Native.WS_MINIMIZEBOX |
                       Native.WS_MAXIMIZEBOX | Native.WS_SYSMENU | Native.WS_MINIMIZE | Native.WS_MAXIMIZE);
            Native.SetWindowLong(win, Native.GWL_STYLE, style | Native.WS_CHILD | Native.WS_VISIBLE);
            int ex = Native.GetWindowLong(win, Native.GWL_EXSTYLE);
            ex &= ~Native.WS_EX_APPWINDOW;
            Native.SetWindowLong(win, Native.GWL_EXSTYLE, ex | Native.WS_EX_LAYERED | Native.WS_EX_NOACTIVATE);
            Native.SetLayeredWindowAttributes(win, 0, 255, Native.LWA_ALPHA);
            Native.SetParent(win, progman);
            wallpaper = win;
            Place(true);
            return true;
        }

        private void Place(bool force)
        {
            if (wallpaper == IntPtr.Zero || !Native.IsWindow(wallpaper)) return;
            // Explorer can make a new wallpaper layer after this app has attached: at sign-in, or whenever an app such as
            // Bing Wallpaper sets a new picture. It goes in front of this window, so look the layers up again every time.
            FindLayers();
            if (iconView == IntPtr.Zero) return; // Explorer is restarting: KeepEdgeRunning starts over once it is back
            Rectangle vs = SystemInformation.VirtualScreen;
            Native.RECT cur;
            bool sameRect = Native.GetWindowRect(wallpaper, out cur) && cur.Left == vs.Left && cur.Top == vs.Top &&
                            cur.Right == vs.Right && cur.Bottom == vs.Bottom;
            bool inFront = IsAboveWorkerW();
            if (!force && sameRect && inFront) return;
            if (!force && !inFront && ++reorders <= 20) Log("the desktop's own wallpaper layer was in front: moved back above it");

            var p = new Native.POINT { X = vs.X, Y = vs.Y };
            Native.ScreenToClient(progman, ref p);
            // FRAMECHANGED: without it Edge keeps sizing the page as if the removed title bar were still there
            Native.SetWindowPos(wallpaper, iconView, p.X, p.Y, vs.Width, vs.Height, Native.SWP_NOACTIVATE | Native.SWP_SHOWWINDOW | Native.SWP_FRAMECHANGED);
            if (workerW != IntPtr.Zero)
                Native.SetWindowPos(workerW, wallpaper, 0, 0, 0, 0, Native.SWP_NOACTIVATE | Native.SWP_NOMOVE | Native.SWP_NOSIZE);
        }

        // Other apps may add their own layers here (Bing Wallpaper does). Only the order against
        // the icons and the WorkerW matters, so don't fight over the exact spot. Any WorkerW counts, not only
        // the one found when attaching, which may since have been replaced.
        private bool IsAboveWorkerW()
        {
            for (IntPtr w = Native.GetWindow(iconView, Native.GW_HWNDNEXT); w != IntPtr.Zero; w = Native.GetWindow(w, Native.GW_HWNDNEXT))
            {
                if (w == wallpaper) return true;
                if (ClassOf(w) == "WorkerW") return false;
            }
            return false;
        }

        private IntPtr FindEdgeWindow()
        {
            IntPtr found = IntPtr.Zero;
            Native.EnumWindows(delegate(IntPtr h, IntPtr l)
            {
                // Don't wait for the page title: the sooner this window goes behind the icons, the better.
                if (ClassOf(h) != "Chrome_WidgetWin_1" || !Native.IsWindowVisible(h)) return true;
                Native.RECT r;
                if (!Native.GetWindowRect(h, out r) || r.Right - r.Left < 800) return true;
                // Last, because other browsers' windows look just the same up to here
                if (!InEdgeJob(PidOf(h))) return true;
                found = h;
                return false;
            }, IntPtr.Zero);
            return found;
        }

        private static int PidOf(IntPtr h)
        {
            uint pid;
            Native.GetWindowThreadProcessId(h, out pid);
            return (int)pid;
        }

        private static string ClassOf(IntPtr h)
        {
            var s = new StringBuilder(128);
            Native.GetClassName(h, s, s.Capacity);
            return s.ToString();
        }

        // ------------------------------------------------------------------ tray, settings, exit
        private ToolStripMenuItem ModeItem(string text, RestMode m)
        {
            return new ToolStripMenuItem(text, null, delegate
            {
                settings.Mode = m;
                ShowMode();
                SaveSettings();
            });
        }

        private void ShowMode()
        {
            desktopItem.Checked = settings.Mode == RestMode.Desktop;
            maximizedItem.Checked = settings.Mode == RestMode.Maximized;
            pausedItem.Checked = settings.Mode == RestMode.Paused;
        }

        private void SaveSettings()
        {
            if (!saveSettings) return;
            try { settings.Save(settingsPath); }
            catch (Exception ex) { Log("could not save settings: " + ex.Message); }
        }

        private static string RunCommand()
        {
            using (RegistryKey k = Registry.CurrentUser.OpenSubKey(RunKey))
                return k == null ? "" : (k.GetValue(RunValue) as string) ?? "";
        }

        private static bool StartsWithWindows()
        {
            return RunCommand().Length > 0;
        }

        private void SetStartup(bool on)
        {
            try
            {
                using (RegistryKey k = Registry.CurrentUser.CreateSubKey(RunKey))
                {
                    if (on) k.SetValue(RunValue, "\"" + Application.ExecutablePath + "\" --startup");
                    else k.DeleteValue(RunValue, false);
                }
            }
            catch (Exception ex)
            {
                Log("Start with Windows: " + ex.Message);
            }
            startupItem.Checked = StartsWithWindows();
        }

        private void OnSessionSwitch(object sender, SessionSwitchEventArgs e)
        {
            bool was = locked;
            if (e.Reason == SessionSwitchReason.SessionLock || e.Reason == SessionSwitchReason.ConsoleDisconnect ||
                e.Reason == SessionSwitchReason.RemoteDisconnect)
                locked = true;
            else if (e.Reason == SessionSwitchReason.SessionUnlock || e.Reason == SessionSwitchReason.ConsoleConnect ||
                     e.Reason == SessionSwitchReason.RemoteConnect)
                locked = false;
            if (locked != was) Log(locked ? "locked: no frames until signed in again" : "signed in again");
        }

        // Asleep, nothing of this wallpaper is on the graphics card; just woken, it waits while Windows brings the screens
        // and the lock screen back. In the log, so a black screen after waking can be told apart from this app.
        private void OnPowerModeChanged(object sender, PowerModeChangedEventArgs e)
        {
            if (e.Mode == PowerModes.Suspend)
            {
                quietUntil = DateTime.MaxValue;
                Log("going to sleep");
                if (running) WriteState(Still);
            }
            else if (e.Mode == PowerModes.Resume)
            {
                quietUntil = DateTime.UtcNow.AddSeconds(WakeQuietSeconds);
                Log("woke up" + (locked ? " (locked)" : "") + ": no frames for " + WakeQuietSeconds + " s");
            }
        }

        private void OnDisplayChanged(object sender, EventArgs e)
        {
            Place(true);
        }

        private void Quit()
        {
            if (quitting) return;
            quitting = true;
            if (setup != null && !setup.IsDisposed) setup.Close();
            timer.Stop();
            if (background != null) background.Restore();
            showWait.Unregister(null);
            SystemEvents.SessionSwitch -= OnSessionSwitch;
            SystemEvents.DisplaySettingsChanged -= OnDisplayChanged;
            SystemEvents.PowerModeChanged -= OnPowerModeChanged;
            StopEdge();
            tray.Visible = false;
            tray.Dispose();
            try { File.Delete(statePath); }
            catch (IOException) { }
            catch (UnauthorizedAccessException) { }
            if (progman != IntPtr.Zero)
                Native.RedrawWindow(progman, IntPtr.Zero, IntPtr.Zero, Native.RDW_INVALIDATE | Native.RDW_ERASE | Native.RDW_ALLCHILDREN | Native.RDW_UPDATENOW);
            ExitThread();
        }

        private void Log(string message)
        {
            try { File.AppendAllText(logPath, DateTime.Now.ToString("HH:mm:ss ") + message + "\r\n"); }
            catch (IOException) { }
        }

        private static Icon DrawIcon()
        {
            using (var bmp = new Bitmap(32, 32))
            using (Graphics g = Graphics.FromImage(bmp))
            using (var sky = new SolidBrush(Color.FromArgb(44, 92, 138)))
            using (var rock = new SolidBrush(Color.FromArgb(232, 238, 244)))
            {
                g.SmoothingMode = SmoothingMode.AntiAlias;
                g.FillEllipse(sky, 1, 1, 30, 30);
                g.FillPolygon(rock, new[] { new Point(4, 25), new Point(14, 8), new Point(19, 16), new Point(22, 12), new Point(29, 25) });
                return Icon.FromHandle(bmp.GetHicon());
            }
        }
    }

    // ====================================================================== the setup window
    /// <summary>
    /// About the app: its version, who made it and how, where to find it, its licence and the data it uses. One at a time.
    /// </summary>
    public sealed class AboutForm : Form
    {
        private static AboutForm open;

        public static void ShowOnce()
        {
            if (open == null || open.IsDisposed)
            {
                open = new AboutForm();
                open.Show();
            }
            if (open.WindowState == FormWindowState.Minimized) open.WindowState = FormWindowState.Normal;
            open.Activate();
        }

        /// <summary>The version people see: 2.2.0, from the exe's own version.</summary>
        public static string VersionText
        {
            get
            {
                Version v = typeof(AboutForm).Assembly.GetName().Version;
                return v.Major + "." + v.Minor + "." + v.Build;
            }
        }

        public AboutForm()
        {
            const int W = 440, Pad = 24;
            SuspendLayout();
            AutoScaleMode = AutoScaleMode.Dpi;
            AutoScaleDimensions = new SizeF(96F, 96F);
            Font = new Font("Segoe UI", 9F);
            BackColor = Color.White;
            ForeColor = Color.FromArgb(26, 26, 26);
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = false;
            MinimizeBox = false;
            ShowInTaskbar = false;
            StartPosition = FormStartPosition.CenterScreen;
            Text = "About Living Earth Himalaya";
            Icon = Host.AppIcon;

            int y = Pad;
            Controls.Add(new Label { Text = "Living Earth Himalaya", Location = new Point(Pad, y), AutoSize = true, Font = new Font("Segoe UI Semibold", 14F) });
            y += 34;
            Controls.Add(new Label { Text = "Version " + VersionText, Location = new Point(Pad, y), AutoSize = true, ForeColor = Color.FromArgb(96, 96, 96) });
            y += 26;
            y = Para("A free live wallpaper for Windows: a Himalayan panorama whose sun, moon, stars, clouds, wind, rain and snow follow the real sky and your local weather.", Pad, y, W - 2 * Pad);
            y += 10;
            Controls.Add(new Label { Text = "Author: Khan Rafaat Abtahe", Location = new Point(Pad, y), AutoSize = true, Font = new Font("Segoe UI Semibold", 9F) });
            y += 22;
            y = Link("februne.com", "https://februne.com", Pad, y);
            y = Link("rafaatabtahe@gmail.com", "mailto:rafaatabtahe@gmail.com", Pad, y);
            y = Link("Source code, help and every version on GitHub", Program.ProjectUrl, Pad, y);
            y += 10;
            y = Para("A personal hobby project, shared as open source. Designed and planned by Khan Rafaat Abtahe; the code was written using Claude.", Pad, y, W - 2 * Pad);
            y += 6;
            y = Para("MIT licence. Weather data from Open-Meteo (CC BY 4.0). Sun and moon formulas adapted from SunCalc (BSD-2-Clause), with moon terms from Meeus, Astronomical Algorithms.", Pad, y, W - 2 * Pad);
            y += 16;
            var ok = new Button { Text = "OK", Location = new Point(W - Pad - 90, y), Size = new Size(90, 30), UseVisualStyleBackColor = true, DialogResult = DialogResult.OK };
            ok.Click += delegate { Close(); };
            Controls.Add(ok);
            AcceptButton = ok;
            CancelButton = ok;
            y += 30 + Pad;
            ClientSize = new Size(W, y);
            ResumeLayout(false);
        }

        private int Para(string text, int x, int y, int w)
        {
            var l = new Label { Text = text, Location = new Point(x, y), MaximumSize = new Size(w, 0), AutoSize = true, ForeColor = Color.FromArgb(64, 64, 64) };
            Controls.Add(l);
            return y + l.PreferredHeight + 4;
        }

        private int Link(string text, string url, int x, int y)
        {
            var l = new LinkLabel { Text = text, Location = new Point(x, y), AutoSize = true };
            l.LinkClicked += delegate
            {
                try { Process.Start(url); }
                catch (Exception) { }
            };
            Controls.Add(l);
            return y + 22;
        }
    }

    public sealed class SetupForm : Form
    {
        // wide rather than tall: the scene switches go in four columns, and the links at the bottom stay clear of the buttons
        private const int W = 760, Pad = 24, Indent = 22, BannerH = 150;
        private static readonly string[] QualityNames =
        {
            "Auto: adjusts to your graphics", "Eco: lightest", "Balanced", "High (recommended)", "Ultra: powerful graphics only"
        };
        private static readonly Color Ink = Color.FromArgb(26, 26, 26);
        private static readonly Color Soft = Color.FromArgb(96, 96, 96);
        private static readonly Color Accent = Color.FromArgb(0, 95, 184);

        private readonly Settings s;
        private readonly Image banner;
        private readonly RadioButton autoRadio, manualRadio, desktopRadio, maximizedRadio, pausedRadio;
        private readonly Label autoStatus, manualStatus;
        private readonly Button detectButton, searchButton, setButton, cancelButton;
        private readonly TextBox searchBox;
        private readonly ListBox results;
        private readonly ComboBox qualityBox, sizeBox, trafficBox;
        private readonly CheckBox startupBox, roadBox, birdsBox, leavesBox, windowsBox;
        private readonly CheckBox treeBox, mistBox, bannersBox, smokeBox, firesBox, lightsBox, starsBox, panelBox;
        private readonly RadioButton topLeft, topRight, bottomLeft, bottomRight;
        private Place detected, manual;
        private int detectRun, searchRun;

        /** Tests turn this off, so opening the window doesn't look up the location. */
        public bool DetectOnShow = true;
        public Settings Result { get { return s; } }
        public bool StartWithWindows { get { return startupBox.Checked; } }
        public bool DetectedNow { get; private set; }
        public bool DemoRequested { get; private set; } // "Watch the demo" was clicked

        public SetupForm(Settings settings, bool startWithWindows, string bannerPath)
        {
            s = settings;
            detected = s.Detected;
            manual = s.Manual;
            banner = LoadImage(bannerPath);

            SuspendLayout();
            AutoScaleMode = AutoScaleMode.Dpi;
            AutoScaleDimensions = new SizeF(96F, 96F);
            Font = new Font("Segoe UI", 9F);
            BackColor = Color.White;
            ForeColor = Ink;
            FormBorderStyle = FormBorderStyle.FixedSingle;
            MaximizeBox = false;
            StartPosition = FormStartPosition.CenterScreen;
            Text = "Living Earth Himalaya - live wallpaper";
            Icon = Host.AppIcon;

            var top = new PictureBox { Location = new Point(0, 0), Size = new Size(W, BannerH) };
            top.Paint += PaintBanner;
            Controls.Add(top);
            int y = BannerH + 16;

            // ---- location
            y = Heading("Location", y);
            var loc = new Panel { Location = new Point(0, y), Width = W };
            int ly = 0;
            autoRadio = Radio(loc, "Find my location automatically", Pad, ly);
            ly += 26;
            autoStatus = Note(loc, "", Pad + Indent, ly, W - 2 * Pad - Indent - 120, 36);
            detectButton = MakeButton(loc, "Detect again", W - Pad - 110, ly, 110);
            ly += 42;
            manualRadio = Radio(loc, "Choose a place", Pad, ly);
            ly += 28;
            searchBox = new TextBox { Location = new Point(Pad + Indent, ly + 1), Width = W - 2 * Pad - Indent - 120 };
            loc.Controls.Add(searchBox);
            searchButton = MakeButton(loc, "Search", W - Pad - 110, ly, 110);
            ly += 34;
            results = new ListBox { Location = new Point(Pad + Indent, ly), Size = new Size(W - 2 * Pad - Indent, 64), IntegralHeight = false };
            loc.Controls.Add(results);
            ly += 68;
            manualStatus = Note(loc, "Type a city or town, or a latitude and longitude such as 27.99, 86.93.", Pad + Indent, ly, W - 2 * Pad - Indent, 20);
            ly += 24;
            loc.Height = ly;
            Controls.Add(loc);
            y += ly + 12;

            // ---- when to animate
            y = Heading("Wallpaper mode", y);
            var modes = new Panel { Location = new Point(0, y), Width = W };
            int my = 0;
            desktopRadio = Radio(modes, "Animate while you look at the desktop (lightest)", Pad, my);
            my += 24;
            maximizedRadio = Radio(modes, "Animate unless a window is maximized or full screen", Pad, my);
            my += 24;
            pausedRadio = Radio(modes, "Paused: keep a still picture", Pad, my);
            my += 26;
            Note(modes, "In the first two modes it keeps moving gently while you work, using very little of the graphics chip, " +
                        "and it is never behind the real sky when you come back.", Pad, my, W - 2 * Pad, 34);
            my += 36;
            modes.Height = my;
            Controls.Add(modes);
            y += my + 12;

            // ---- what is in the scene: everything can be turned off, in four columns to keep the window short. The first
            // is wider, for the road's traffic list.
            y = Heading("In the scene", y);
            const int Col1 = 200, ColW = (W - 2 * Pad - Col1) / 3;
            int c1 = Pad, c2 = Pad + Col1, c3 = c2 + ColW, c4 = c3 + ColW;
            roadBox = Check("Road", c1, y, s.Road);
            trafficBox = new ComboBox { DropDownStyle = ComboBoxStyle.DropDownList, Location = new Point(c1 + 62, y - 2), Width = 102 };
            trafficBox.Items.AddRange(new object[] { "Light traffic", "Normal traffic", "Busy traffic" });
            trafficBox.SelectedIndex = Math.Max(0, Array.IndexOf(Settings.Traffics, s.Traffic));
            trafficBox.Enabled = s.Road;
            Controls.Add(trafficBox);
            roadBox.CheckedChanged += delegate { trafficBox.Enabled = roadBox.Checked; };
            birdsBox = Check("Birds", c2, y, s.Birds);
            treeBox = Check("Tree on the rock", c3, y, s.Tree);
            leavesBox = Check("Flying leaves", c4, y, s.Leaves);
            leavesBox.Enabled = s.Tree; // the leaves come off the tree
            treeBox.CheckedChanged += delegate { leavesBox.Enabled = treeBox.Checked; };
            mistBox = Check("Forest mist", c1, y + 24, s.Mist);
            bannersBox = Check("Clouds on the peaks", c2, y + 24, s.Banners);
            smokeBox = Check("Village smoke", c3, y + 24, s.Smoke);
            firesBox = Check("Burning fields", c4, y + 24, s.Fires);
            lightsBox = Check("Village lights", c1, y + 48, s.Lights);
            starsBox = Check("Shooting stars", c2, y + 48, s.Stars);
            y += 76;

            // ---- the clock and weather panel: whether it shows, its corner (laid out like the screen) and its size
            y = Heading("Clock and weather panel", y);
            panelBox = Check("Show it", Pad, y, s.Panel);
            // a panel of their own, or they would be one group with the radio buttons above
            var corners = new Panel { Location = new Point(Pad + 100, y), Size = new Size(240, 48) };
            topLeft = Radio(corners, "Top left", 0, 0);
            topRight = Radio(corners, "Top right", 116, 0);
            bottomLeft = Radio(corners, "Bottom left", 0, 24);
            bottomRight = Radio(corners, "Bottom right", 116, 24);
            Controls.Add(corners);
            var sizeLabel = new Label { Text = "Size", Location = new Point(W - Pad - 104 - 38, y + 4), AutoSize = true };
            Controls.Add(sizeLabel);
            sizeBox = new ComboBox { DropDownStyle = ComboBoxStyle.DropDownList, Location = new Point(W - Pad - 104, y), Width = 104 };
            sizeBox.Items.AddRange(new object[] { "Small", "Medium", "Large" });
            sizeBox.SelectedIndex = Math.Max(0, Array.IndexOf(Settings.PanelSizes, s.PanelSize));
            Controls.Add(sizeBox);
            corners.Enabled = sizeBox.Enabled = sizeLabel.Enabled = s.Panel;
            panelBox.CheckedChanged += delegate { corners.Enabled = sizeBox.Enabled = sizeLabel.Enabled = panelBox.Checked; };
            y += 52;
            Note(this, "Turning the road on or off shapes the mountains again, which takes a few minutes. " +
                       "With two screens side by side, left and right mean the left and right screen.", Pad, y, W - 2 * Pad, 34);
            y += 36 + 12;

            // ---- quality and start-up
            y = Heading("Quality and start-up", y);
            var ql = new Label { Text = "Quality", Location = new Point(Pad, y + 4), AutoSize = true };
            Controls.Add(ql);
            qualityBox = new ComboBox { DropDownStyle = ComboBoxStyle.DropDownList, Location = new Point(Pad + 72, y), Width = 250 };
            qualityBox.Items.AddRange(QualityNames);
            qualityBox.SelectedIndex = Math.Max(0, Array.IndexOf(Settings.Qualities, s.Quality));
            Controls.Add(qualityBox);
            startupBox = new CheckBox { Text = "Start with Windows", Checked = startWithWindows, Location = new Point(Pad + 72 + 250 + 24, y + 3), AutoSize = true };
            Controls.Add(startupBox);
            y += 34;
            windowsBox = Check("Show the scene in Windows Settings too, as the desktop background picture", Pad, y, s.WindowsBackground);
            y += 22;
            Note(this, "A still for the time of day, so Personalization shows it. Exit puts your own picture back.", Pad + Indent - 3, y, W - 2 * Pad - Indent, 18);
            y += 28;

            Controls.Add(new Panel { Location = new Point(0, y), Size = new Size(W, 1), BackColor = Color.FromArgb(228, 228, 228) });
            y += 16;
            var link = new LinkLabel { Text = "Help and source code", Location = new Point(Pad, y + 9), AutoSize = true };
            link.LinkClicked += delegate
            {
                try { Process.Start(Program.ProjectUrl); }
                catch (Exception) { }
            };
            Controls.Add(link);
            var about = new LinkLabel { Text = "About", Location = new Point(link.Right + 18, y + 9), AutoSize = true };
            about.LinkClicked += delegate { AboutForm.ShowOnce(); };
            Controls.Add(about);
            var demoLink = new LinkLabel { Text = "Watch the demo", Location = new Point(about.Right + 18, y + 9), AutoSize = true };
            var tips = new ToolTip();
            tips.SetToolTip(demoLink, "A year in two minutes, over and over. To stop it, choose Play the demo again in the tray menu.");
            FormClosed += delegate { tips.Dispose(); };
            demoLink.LinkClicked += delegate
            {
                DemoRequested = true;
                Apply(); // sets the wallpaper with these settings, then plays the demo on it
            };
            Controls.Add(demoLink);
            setButton = new Button
            {
                Text = "Set wallpaper", Location = new Point(W - Pad - 150, y), Size = new Size(150, 34),
                FlatStyle = FlatStyle.Flat, BackColor = Accent, ForeColor = Color.White,
                Font = new Font("Segoe UI Semibold", 9.5F)
            };
            setButton.FlatAppearance.BorderSize = 0;
            Controls.Add(setButton);
            cancelButton = new Button { Text = "Cancel", Location = new Point(W - Pad - 150 - 10 - 100, y), Size = new Size(100, 34), UseVisualStyleBackColor = true };
            Controls.Add(cancelButton);
            y += 34 + Pad - 4;
            ClientSize = new Size(W, y);

            // ---- starting values
            bool auto = s.AutoLocation || manual == null;
            autoRadio.Checked = auto;
            manualRadio.Checked = !auto;
            autoStatus.Text = detected != null ? Describe(detected) : "Not found yet.";
            if (manual != null) manualStatus.Text = "Chosen: " + manual.Detail;
            desktopRadio.Checked = s.Mode == RestMode.Desktop || s.Mode == RestMode.Always;
            maximizedRadio.Checked = s.Mode == RestMode.Maximized;
            pausedRadio.Checked = s.Mode == RestMode.Paused;
            topLeft.Checked = s.Corner == "left-top";
            topRight.Checked = s.Corner == "right-top";
            bottomLeft.Checked = s.Corner == "left-bottom";
            bottomRight.Checked = !(topLeft.Checked || topRight.Checked || bottomLeft.Checked);

            // ---- events
            autoRadio.CheckedChanged += delegate
            {
                UpdateButtons();
                if (autoRadio.Checked && detected == null) Detect();
            };
            manualRadio.CheckedChanged += delegate { UpdateButtons(); };
            detectButton.Click += delegate
            {
                autoRadio.Checked = true;
                Detect();
            };
            searchButton.Click += delegate { Search(); };
            // Enter in the search box searches; elsewhere it sets the wallpaper
            searchBox.Enter += delegate { AcceptButton = searchButton; };
            searchBox.Leave += delegate { AcceptButton = setButton; };
            searchBox.TextChanged += delegate { if (searchBox.Focused && searchBox.Text.Length > 0) manualRadio.Checked = true; };
            searchBox.HandleCreated += delegate { Native.SendMessage(searchBox.Handle, 0x1501, new IntPtr(1), "City, town, or latitude, longitude"); };
            results.SelectedIndexChanged += delegate
            {
                var p = results.SelectedItem as Place;
                if (p == null) return;
                manual = p;
                manualRadio.Checked = true;
                manualStatus.Text = "Chosen: " + p.Detail;
                UpdateButtons();
            };
            setButton.Click += delegate { Apply(); };
            cancelButton.Click += delegate { Close(); };
            AcceptButton = setButton;
            UpdateButtons();
            ResumeLayout(false);
        }

        protected override void OnLoad(EventArgs e)
        {
            base.OnLoad(e);
            FitTo(Screen.FromPoint(MousePosition).WorkingArea);
        }

        /**
         * About 860 px tall at 100% scale, so at 125% or more on a 1080p screen the window would run off the bottom.
         * Then it takes the screen's height and scrolls, a little wider so the scroll bar covers nothing.
         */
        internal void FitTo(Rectangle area)
        {
            if (Height <= area.Height) return;
            int full = ClientSize.Height;
            AutoScroll = true;
            AutoScrollMinSize = new Size(0, full);
            ClientSize = new Size(ClientSize.Width + SystemInformation.VerticalScrollBarWidth, full - (Height - area.Height));
            Location = new Point(area.Left + Math.Max(0, (area.Width - Width) / 2), area.Top);
        }

        protected override void OnShown(EventArgs e)
        {
            base.OnShown(e);
            if (DetectOnShow && autoRadio.Checked) Detect();
            setButton.Focus();
        }

        private void UpdateButtons()
        {
            setButton.Enabled = autoRadio.Checked || manual != null;
            setButton.BackColor = setButton.Enabled ? Accent : Color.FromArgb(160, 160, 160);
        }

        private async void Detect()
        {
            int run = ++detectRun;
            detectButton.Enabled = false;
            autoStatus.Text = "Finding your location...";
            Place p = null;
            try { p = await Locator.DetectAsync(detected, true); }
            catch (Exception) { }
            if (IsDisposed || run != detectRun) return;
            detectButton.Enabled = true;
            if (p != null)
            {
                detected = p;
                DetectedNow = true;
                autoStatus.Text = Describe(p);
            }
            else
            {
                autoStatus.Text = detected != null
                    ? Describe(detected) + " (could not check again just now)"
                    : "Could not find your location. Check the internet connection, or choose a place below.";
            }
        }

        private async void Search()
        {
            string text = searchBox.Text.Trim();
            if (text.Length < 2)
            {
                manualStatus.Text = "Type at least two letters.";
                return;
            }
            int run = ++searchRun;
            manualRadio.Checked = true;
            searchButton.Enabled = false;
            results.Items.Clear();
            manualStatus.Text = "Searching...";
            List<Place> found = null;
            try { found = await Locator.SearchAsync(text); }
            catch (Exception) { }
            if (IsDisposed || run != searchRun) return;
            searchButton.Enabled = true;
            if (found == null)
            {
                manualStatus.Text = "The search didn't work. Check the internet connection and try again.";
                return;
            }
            if (found.Count == 0)
            {
                manualStatus.Text = "No places found for \"" + text + "\".";
                return;
            }
            foreach (Place p in found) results.Items.Add(p);
            manualStatus.Text = "Pick the right one from the list.";
            if (found.Count == 1) results.SelectedIndex = 0;
        }

        private void Apply()
        {
            s.AutoLocation = autoRadio.Checked || manual == null;
            s.Manual = manual;
            if (detected != null) s.Detected = detected;
            s.Mode = maximizedRadio.Checked ? RestMode.Maximized : pausedRadio.Checked ? RestMode.Paused : RestMode.Desktop;
            s.Quality = Settings.Qualities[Math.Max(0, qualityBox.SelectedIndex)];
            s.Road = roadBox.Checked;
            s.Birds = birdsBox.Checked;
            s.Leaves = leavesBox.Checked;
            s.Tree = treeBox.Checked;
            s.Mist = mistBox.Checked;
            s.Banners = bannersBox.Checked;
            s.Smoke = smokeBox.Checked;
            s.Fires = firesBox.Checked;
            s.Lights = lightsBox.Checked;
            s.Stars = starsBox.Checked;
            s.Panel = panelBox.Checked;
            s.Corner = topLeft.Checked ? "left-top" : topRight.Checked ? "right-top" : bottomLeft.Checked ? "left-bottom" : "right-bottom";
            s.PanelSize = Settings.PanelSizes[Math.Max(0, sizeBox.SelectedIndex)];
            s.Traffic = Settings.Traffics[Math.Max(0, trafficBox.SelectedIndex)];
            s.WindowsBackground = windowsBox.Checked;
            DialogResult = DialogResult.OK;
            Close();
        }

        private static string Describe(Place p)
        {
            return p.Detail + (p.Source.Length > 0 ? "\nFound using " + p.Source : "");
        }

        private int Heading(string text, int y)
        {
            HeadingAt(text, Pad, y);
            return y + 28;
        }

        private void HeadingAt(string text, int x, int y)
        {
            Controls.Add(new Label { Text = text, Location = new Point(x, y), AutoSize = true, Font = new Font("Segoe UI Semibold", 10.5F), ForeColor = Ink });
        }

        private CheckBox Check(string text, int x, int y, bool on)
        {
            var c = new CheckBox { Text = text, Checked = on, Location = new Point(x, y), AutoSize = true };
            Controls.Add(c);
            return c;
        }

        private static RadioButton Radio(Control parent, string text, int x, int y)
        {
            var r = new RadioButton { Text = text, Location = new Point(x, y), AutoSize = true };
            parent.Controls.Add(r);
            return r;
        }

        private static Label Note(Control parent, string text, int x, int y, int w, int h)
        {
            var l = new Label { Text = text, Location = new Point(x, y), Size = new Size(w, h), ForeColor = Soft };
            parent.Controls.Add(l);
            return l;
        }

        private static Button MakeButton(Control parent, string text, int x, int y, int w)
        {
            var b = new Button { Text = text, Location = new Point(x, y), Size = new Size(w, 28), UseVisualStyleBackColor = true };
            parent.Controls.Add(b);
            return b;
        }

        private static Image LoadImage(string path)
        {
            try { return File.Exists(path) ? Image.FromStream(new MemoryStream(File.ReadAllBytes(path))) : null; }
            catch (Exception) { return null; }
        }

        private void PaintBanner(object sender, PaintEventArgs e)
        {
            Graphics g = e.Graphics;
            Rectangle r = ((Control)sender).ClientRectangle;
            g.InterpolationMode = InterpolationMode.HighQualityBicubic;
            g.PixelOffsetMode = PixelOffsetMode.HighQuality;
            if (banner != null)
            {
                // fill the width and keep the band with the peaks
                float scale = (float)r.Width / banner.Width;
                float srcH = Math.Min(banner.Height, r.Height / scale);
                float srcY = Math.Max(0, Math.Min(banner.Height - srcH, banner.Height * 0.5f - srcH / 2));
                g.DrawImage(banner, r, new RectangleF(0, srcY, banner.Width, srcH), GraphicsUnit.Pixel);
            }
            else
            {
                using (var b = new LinearGradientBrush(r, Color.FromArgb(70, 120, 170), Color.FromArgb(18, 30, 48), 90f))
                    g.FillRectangle(b, r);
            }
            using (var shade = new LinearGradientBrush(r, Color.FromArgb(170, 6, 14, 28), Color.FromArgb(0, 6, 14, 28), 0f))
                g.FillRectangle(shade, r);
            g.TextRenderingHint = TextRenderingHint.AntiAlias;
            using (var title = new Font("Segoe UI Light", 24F))
            using (var sub = new Font("Segoe UI", 9.5F))
            using (var white = new SolidBrush(Color.White))
            using (var soft = new SolidBrush(Color.FromArgb(230, 255, 255, 255)))
            {
                float x = r.Width * 0.04f;
                g.DrawString("Living Earth Himalaya", title, white, x - 3, r.Height * 0.42f);
                g.DrawString("A live wallpaper with the real sun, moon, stars and weather", sub, soft, x, r.Height * 0.74f);
            }
        }
    }

    // ====================================================================== Windows' own background
    /// <summary>
    /// Shows this wallpaper in Windows' own Settings > Personalization: sets the Windows desktop background to a still of
    /// the scene for the part of the day, and puts back what was there before when asked to (Exit, or the option turned
    /// off). Windows can't take a picture of the live wallpaper: Edge draws it with the graphics chip behind the desktop
    /// icons, where PrintWindow sees only black. So the stills are rendered ahead of time (host/stills.mjs) and travel in
    /// the exe. What was there before is kept in a file of its own, so a crash or a restart can't lose it.
    /// </summary>
    public sealed class WindowsBackground
    {
        // name: rendered with the sun at this altitude (see host/stills.mjs). StillFor chooses between them.
        public static readonly string[] Names = { "night", "dawn", "morning", "day", "golden", "dusk" };
        private const string DesktopKey = @"Control Panel\Desktop";

        private readonly string stillsDir, dataDir, savedPath;
        private readonly Action<string> log;

        // Tests replace these, so they never touch the real background: (path, style, tile)
        public Func<string[]> Read = ReadWindows;
        public Action<string, string, string> Write = WriteWindows;

        public WindowsBackground(string stillsDir, string dataDir, Action<string> log)
        {
            this.stillsDir = stillsDir;
            this.dataDir = dataDir;
            this.log = log;
            savedPath = Path.Combine(dataDir, "windows-background.ini");
        }

        /// <summary>The still for where the sun is: the same bands as host/stills.mjs.</summary>
        public static string StillFor(DateTime utc, double lat, double lon)
        {
            double alt, az;
            Sun(utc, lat, lon, out alt, out az);
            bool morning = az < 180;
            if (alt < -10) return "night";
            if (alt < 1) return morning ? "dawn" : "dusk";
            if (alt < 15) return morning ? "morning" : "golden";
            return "day";
        }

        /// <summary>The sun's altitude above the horizon and its compass bearing, in degrees, as src/services/astronomy.js has them.</summary>
        public static void Sun(DateTime utc, double lat, double lon, out double altDeg, out double azDeg)
        {
            const double rad = Math.PI / 180;
            double d = (utc.ToUniversalTime() - new DateTime(2000, 1, 1, 12, 0, 0, DateTimeKind.Utc)).TotalDays;
            double M = rad * (357.5291 + 0.98560028 * d);
            double C = rad * (1.9148 * Math.Sin(M) + 0.02 * Math.Sin(2 * M) + 0.0003 * Math.Sin(3 * M));
            double L = M + C + rad * 102.9372 + Math.PI;
            const double e = rad * 23.4397;
            double dec = Math.Asin(Math.Sin(e) * Math.Sin(L));
            double ra = Math.Atan2(Math.Sin(L) * Math.Cos(e), Math.Cos(L));
            double H = rad * (280.16 + 360.9856235 * d) + rad * lon - ra;
            double phi = rad * lat;
            double alt = Math.Asin(Math.Sin(phi) * Math.Sin(dec) + Math.Cos(phi) * Math.Cos(dec) * Math.Cos(H));
            double az = Math.Atan2(Math.Sin(H), Math.Cos(H) * Math.Sin(phi) - Math.Tan(dec) * Math.Cos(phi));
            altDeg = alt / rad;
            azDeg = ((az / rad + 180) % 360 + 360) % 360;
        }

        /// <summary>Puts this still up, unless it is up already. Returns true if it changed the background.</summary>
        public bool Show(string name, bool span)
        {
            string src = Path.Combine(stillsDir, name + ".jpg");
            if (!File.Exists(src)) return false; // a build without the stills
            string[] now = Read();
            Dictionary<string, string> saved = Load();
            string shown;
            if (IsOurs(now[0]) && saved.TryGetValue("shown", out shown) && shown == name) return false;
            try
            {
                if (!IsOurs(now[0]))
                {
                    // someone's own picture, or one another app put there since: that is what goes back on Exit
                    saved["previous.wallpaper"] = now[0];
                    saved["previous.style"] = now[1];
                    saved["previous.tile"] = now[2];
                }
                // two names in turn: given the same path again, Windows can keep showing the old picture
                string file = Path.Combine(dataDir, "windows-background-" + (now[0].EndsWith("-a.jpg", StringComparison.OrdinalIgnoreCase) ? "b" : "a") + ".jpg");
                File.Copy(src, file, true);
                saved["shown"] = name;
                Save(saved); // before the change, so what goes back is never lost
                Write(file, span ? "22" : "10", "0"); // span across the screens, or fill the one
                log("Windows background: the " + name + " still");
                return true;
            }
            catch (Exception ex)
            {
                log("Windows background: " + ex.Message);
                return false;
            }
        }

        /// <summary>Puts back what was there before. Returns true if it changed the background.</summary>
        public bool Restore()
        {
            Dictionary<string, string> saved = Load();
            string path, style, tile;
            if (!saved.TryGetValue("previous.wallpaper", out path)) return false;
            saved.TryGetValue("previous.style", out style);
            saved.TryGetValue("previous.tile", out tile);
            bool changed = false, keep = false;
            try
            {
                if (!IsOurs(Read()[0]))
                    log("Windows background: changed by something else meanwhile, left as it is");
                else if (path.Length > 0 && !File.Exists(path))
                {
                    log("Windows background: the picture from before is gone (" + path + "), so the still stays");
                    keep = true;
                }
                else
                {
                    Write(path, style ?? "10", tile ?? "0"); // an empty path is a plain colour
                    log("Windows background: back to " + (path.Length > 0 ? path : "a plain colour"));
                    changed = true;
                }
                File.Delete(savedPath);
                if (!keep)
                    foreach (string f in new[] { "a", "b" }) File.Delete(Path.Combine(dataDir, "windows-background-" + f + ".jpg"));
            }
            catch (Exception ex)
            {
                log("Windows background: " + ex.Message);
            }
            return changed;
        }

        public bool IsOurs(string path)
        {
            if (string.IsNullOrEmpty(path)) return false;
            string name = Path.GetFileName(path);
            return name.StartsWith("windows-background-", StringComparison.OrdinalIgnoreCase) &&
                   string.Equals(Path.GetDirectoryName(Path.GetFullPath(path)).TrimEnd('\\'), Path.GetFullPath(dataDir).TrimEnd('\\'), StringComparison.OrdinalIgnoreCase);
        }

        private Dictionary<string, string> Load()
        {
            var v = new Dictionary<string, string>();
            try
            {
                if (File.Exists(savedPath))
                    foreach (string line in File.ReadAllLines(savedPath, Encoding.UTF8))
                    {
                        int eq = line.IndexOf('=');
                        if (eq > 0) v[line.Substring(0, eq)] = line.Substring(eq + 1);
                    }
            }
            catch (IOException) { }
            catch (UnauthorizedAccessException) { }
            return v;
        }

        private void Save(Dictionary<string, string> v)
        {
            var b = new StringBuilder();
            foreach (KeyValuePair<string, string> kv in v) b.Append(kv.Key).Append('=').Append(kv.Value).Append("\r\n");
            File.WriteAllText(savedPath, b.ToString(), new UTF8Encoding(false));
        }

        private static string[] ReadWindows()
        {
            using (RegistryKey k = Registry.CurrentUser.OpenSubKey(DesktopKey))
            {
                if (k == null) return new[] { "", "10", "0" };
                return new[] { (k.GetValue("Wallpaper") as string) ?? "", (k.GetValue("WallpaperStyle") as string) ?? "10", (k.GetValue("TileWallpaper") as string) ?? "0" };
            }
        }

        private static void WriteWindows(string path, string style, string tile)
        {
            using (RegistryKey k = Registry.CurrentUser.CreateSubKey(DesktopKey))
            {
                k.SetValue("WallpaperStyle", style);
                k.SetValue("TileWallpaper", tile);
            }
            if (!Native.SystemParametersInfo(Native.SPI_SETDESKWALLPAPER, 0, path, Native.SPIF_UPDATEINIFILE | Native.SPIF_SENDCHANGE))
                throw new IOException("Windows refused the picture (" + Marshal.GetLastWin32Error() + ")");
        }
    }

    internal static class Native
    {
        public const int GWL_STYLE = -16, GWL_EXSTYLE = -20;
        public const int WS_POPUP = unchecked((int)0x80000000), WS_CHILD = 0x40000000, WS_MINIMIZE = 0x20000000, WS_VISIBLE = 0x10000000;
        public const int WS_MAXIMIZE = 0x01000000, WS_CAPTION = 0x00C00000, WS_SYSMENU = 0x00080000, WS_THICKFRAME = 0x00040000;
        public const int WS_MINIMIZEBOX = 0x00020000, WS_MAXIMIZEBOX = 0x00010000;
        public const int WS_EX_APPWINDOW = 0x00040000, WS_EX_LAYERED = 0x00080000, WS_EX_NOACTIVATE = 0x08000000;
        public const uint LWA_ALPHA = 2, GW_HWNDNEXT = 2;
        public const uint SWP_NOSIZE = 1, SWP_NOMOVE = 2, SWP_NOACTIVATE = 0x10, SWP_FRAMECHANGED = 0x20, SWP_SHOWWINDOW = 0x40;
        public const uint RDW_INVALIDATE = 1, RDW_ERASE = 4, RDW_ALLCHILDREN = 0x80, RDW_UPDATENOW = 0x100;
        public const int STARTF_USESHOWWINDOW = 1;
        public const short SW_SHOWMINNOACTIVE = 7;
        public const uint CREATE_SUSPENDED = 4, BELOW_NORMAL_PRIORITY_CLASS = 0x4000;
        public const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000, JOB_OBJECT_LIMIT_PRIORITY_CLASS = 0x20;
        public const int JobObjectExtendedLimitInformation = 9;

        public const uint SPI_SETDESKWALLPAPER = 0x14, SPIF_UPDATEINIFILE = 1, SPIF_SENDCHANGE = 2;

        public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
        [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        public static extern bool SystemParametersInfo(uint action, uint param, string value, uint winIni);

        [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
        [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        public struct STARTUPINFO
        {
            public int cb;
            public string lpReserved, lpDesktop, lpTitle;
            public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
            public short wShowWindow, cbReserved2;
            public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct PROCESS_INFORMATION
        {
            public IntPtr hProcess, hThread;
            public int dwProcessId, dwThreadId;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct JOBOBJECT_BASIC_LIMIT_INFORMATION
        {
            public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
            public uint LimitFlags;
            public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
            public uint ActiveProcessLimit;
            public UIntPtr Affinity;
            public uint PriorityClass, SchedulingClass;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct IO_COUNTERS { public ulong A, B, C, D, E, F; }

        [StructLayout(LayoutKind.Sequential)]
        public struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
        {
            public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
            public IO_COUNTERS IoInfo;
            public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
        }

        [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
        [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr FindWindow(string cls, string title);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr FindWindowEx(IntPtr parent, IntPtr after, string cls, string title);
        [DllImport("user32.dll")] public static extern IntPtr SendMessageTimeout(IntPtr h, uint msg, IntPtr w, IntPtr l, uint flags, uint timeout, out IntPtr result);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr SendMessage(IntPtr h, int msg, IntPtr w, string l);
        [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc proc, IntPtr l);
        [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
        [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
        [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
        [DllImport("user32.dll", EntryPoint = "GetWindowLongW")] public static extern int GetWindowLong(IntPtr h, int i);
        [DllImport("user32.dll", EntryPoint = "SetWindowLongW")] public static extern int SetWindowLong(IntPtr h, int i, int v);
        [DllImport("user32.dll")] public static extern bool SetLayeredWindowAttributes(IntPtr h, uint key, byte alpha, uint flags);
        [DllImport("user32.dll")] public static extern IntPtr SetParent(IntPtr child, IntPtr parent);
        [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int w, int cy, uint flags);
        [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h, uint cmd);
        [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
        [DllImport("user32.dll")] public static extern bool ScreenToClient(IntPtr h, ref POINT p);
        [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
        [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr h);
        [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] public static extern bool RedrawWindow(IntPtr h, IntPtr rect, IntPtr rgn, uint flags);

        [DllImport("kernel32.dll")] public static extern bool GetSystemTimes(out long idle, out long kernel, out long user);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        public static extern bool CreateProcess(string app, string cmd, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string dir, ref STARTUPINFO si, out PROCESS_INFORMATION pi);
        [DllImport("kernel32.dll")] public static extern uint ResumeThread(IntPtr h);
        [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);
        [DllImport("kernel32.dll")] public static extern uint WaitForSingleObject(IntPtr h, uint ms);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr CreateJobObject(IntPtr attr, string name);
        [DllImport("kernel32.dll", SetLastError = true)] public static extern bool SetInformationJobObject(IntPtr job, int cls, IntPtr info, uint size);
        [DllImport("kernel32.dll", SetLastError = true)] public static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
        [DllImport("kernel32.dll")] public static extern bool TerminateJobObject(IntPtr job, uint code);
        [DllImport("kernel32.dll")] public static extern bool QueryInformationJobObject(IntPtr job, int cls, IntPtr info, uint size, out uint returned);
        [DllImport("kernel32.dll")] public static extern bool GetExitCodeProcess(IntPtr h, out uint code);
        [DllImport("kernel32.dll")] public static extern bool GetProcessTimes(IntPtr h, out long created, out long ended, out long kernel, out long user);
        [DllImport("kernel32.dll")] public static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool result);
        [DllImport("kernel32.dll")] public static extern IntPtr GetCurrentProcess();
        public const uint STILL_ACTIVE = 259;
        [DllImport("kernel32.dll")] public static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
        public const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
        public const int JobObjectBasicAccountingInformation = 1;
    }
}
