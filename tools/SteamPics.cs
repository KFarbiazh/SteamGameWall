// Minimal readers for Steam's PICS caches (appcache/appinfo.vdf, appcache/packageinfo.vdf).
// Binary KeyValues; appinfo v29+ stores key names in a trailing string table.
using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Text;

public static class SteamPics
{
    const byte T_SECTION = 0, T_STRING = 1, T_INT32 = 2, T_FLOAT = 3, T_PTR = 4, T_WSTRING = 5,
               T_COLOR = 6, T_UINT64 = 7, T_END = 8, T_INT64 = 10, T_END_ALT = 11;

    static string ReadCString(BinaryReader r)
    {
        var bytes = new List<byte>(32);
        byte b;
        while ((b = r.ReadByte()) != 0) bytes.Add(b);
        return Encoding.UTF8.GetString(bytes.ToArray());
    }

    static string ReadWString(BinaryReader r)
    {
        var sb = new StringBuilder();
        ushort c;
        while ((c = r.ReadUInt16()) != 0) sb.Append((char)c);
        return sb.ToString();
    }

    static Hashtable ReadKV(BinaryReader r, string[] strings)
    {
        var node = new Hashtable(StringComparer.OrdinalIgnoreCase);
        while (true)
        {
            byte type = r.ReadByte();
            if (type == T_END || type == T_END_ALT) return node;
            string key = strings != null ? strings[r.ReadInt32()] : ReadCString(r);
            switch (type)
            {
                case T_SECTION: node[key] = ReadKV(r, strings); break;
                case T_STRING: node[key] = ReadCString(r); break;
                case T_WSTRING: node[key] = ReadWString(r); break;
                case T_INT32: case T_PTR: case T_COLOR: node[key] = r.ReadInt32(); break;
                case T_FLOAT: node[key] = r.ReadSingle(); break;
                case T_UINT64: node[key] = r.ReadUInt64(); break;
                case T_INT64: node[key] = r.ReadInt64(); break;
                default: throw new InvalidDataException("Unknown KV type " + type + " at " + r.BaseStream.Position);
            }
        }
    }

    // Returns appid -> "appinfo" section (common, extended, config...).
    public static Dictionary<uint, Hashtable> ReadAppInfo(string path)
    {
        var result = new Dictionary<uint, Hashtable>();
        using (var r = new BinaryReader(File.OpenRead(path)))
        {
            uint magic = r.ReadUInt32();
            r.ReadUInt32(); // universe
            string[] strings = null;
            if (magic >= 0x07564429)
            {
                long tableOffset = r.ReadInt64();
                long back = r.BaseStream.Position;
                r.BaseStream.Position = tableOffset;
                int count = r.ReadInt32();
                strings = new string[count];
                for (int i = 0; i < count; i++) strings[i] = ReadCString(r);
                r.BaseStream.Position = back;
            }
            else if (magic != 0x07564428 && magic != 0x07564427)
                throw new InvalidDataException(string.Format("Unsupported appinfo magic 0x{0:X8}", magic));

            while (true)
            {
                uint appid = r.ReadUInt32();
                if (appid == 0) break;
                uint size = r.ReadUInt32();
                long next = r.BaseStream.Position + size;
                r.ReadUInt32(); r.ReadUInt32(); r.ReadUInt64(); r.ReadBytes(20); r.ReadUInt32();
                if (magic >= 0x07564428) r.ReadBytes(20);
                var root = ReadKV(r, strings);
                var info = root["appinfo"] as Hashtable;
                if (info != null) result[appid] = info;
                r.BaseStream.Position = next;
            }
        }
        return result;
    }

    // Returns every appid referenced by the cached (licensed) packages.
    public static HashSet<uint> ReadPackageAppIds(string path)
    {
        var apps = new HashSet<uint>();
        using (var r = new BinaryReader(File.OpenRead(path)))
        {
            uint magic = r.ReadUInt32();
            r.ReadUInt32();
            while (r.BaseStream.Position < r.BaseStream.Length)
            {
                uint packageId = r.ReadUInt32();
                if (packageId == 0xFFFFFFFF) break;
                r.ReadBytes(20); r.ReadUInt32();
                if (magic >= 0x06565528) r.ReadUInt64();
                var root = ReadKV(r, null);
                foreach (DictionaryEntry pkg in root)
                {
                    var p = pkg.Value as Hashtable;
                    if (p == null) continue;
                    var ids = p["appids"] as Hashtable;
                    if (ids == null) continue;
                    foreach (var v in ids.Values) apps.Add(Convert.ToUInt32(v));
                }
            }
        }
        return apps;
    }
}
