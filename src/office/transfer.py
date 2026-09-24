"""Fixed, offline transport helper. Parsers never see the source workspace.

This code runs only inside the approved Linux image. dir_fd + O_NOFOLLOW are
used on every component, including output parents; no host path is interpreted
by a document parser or followed after a string-based containment check.
"""
import errno
import base64
import hashlib
import json
import os
import re
import stat
import sys

MAX_FILE = 128 * 1024 * 1024
MAX_TOTAL = 256 * 1024 * 1024
PRIVATE = {".git", ".kkcode", ".ssh", ".aws", ".azure", ".kube", ".gnupg", ".docker",
           ".npmrc", ".pypirc", ".netrc", ".envrc", ".mcp.json", "id_rsa", "id_ed25519", "credentials"}
DIRECTORY = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW


class TransferError(Exception):
    def __init__(self, code, message, details=None):
        super().__init__(message)
        self.code, self.details = code, details


def parts(relative):
    if not isinstance(relative, str) or not relative or re.search(r"[\\\x00-\x1f\x7f]", relative):
        raise TransferError("office_scope", "文档路径无效。")
    value = relative.split("/")
    if any(not item or item in (".", "..") or item.lower() in PRIVATE
           or re.match(r"^\.env(?:\.|$)", item, re.I) for item in value):
        raise TransferError("office_scope", "文档路径不能访问工作区外或私密配置目录。")
    return value


def descend(root, components, create=False):
    current = os.dup(root)
    try:
        for item in components:
            if create:
                try:
                    os.mkdir(item, 0o700, dir_fd=current)
                except FileExistsError:
                    pass
            following = os.open(item, DIRECTORY, dir_fd=current)
            os.close(current)
            current = following
        return current
    except BaseException:
        os.close(current)
        raise


def read_file(root, relative, expected=None):
    components = parts(relative)
    parent = descend(root, components[:-1])
    try:
        descriptor = os.open(components[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
    finally:
        os.close(parent)
    try:
        before = os.fstat(descriptor)
        if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or before.st_size > MAX_FILE:
            raise TransferError("office_input", "只接受不超过 128 MiB 的独立普通文件，不能使用硬链接或特殊文件。")
        chunks, size = [], 0
        while True:
            chunk = os.read(descriptor, 1024 * 1024)
            if not chunk:
                break
            chunks.append(chunk)
            size += len(chunk)
            if size > MAX_FILE:
                raise TransferError("office_limit", "文档文件超过大小上限。")
        after = os.fstat(descriptor)
        if (after.st_nlink, after.st_size, after.st_mtime_ns, after.st_ctime_ns) != (
                1, before.st_size, before.st_mtime_ns, before.st_ctime_ns):
            raise TransferError("office_changed", "文档在读取过程中发生变化，未接受不一致内容。")
        content = b"".join(chunks)
        digest = hashlib.sha256(content).hexdigest()
        if expected is not None and digest != expected:
            raise TransferError("office_changed", "文档内容与已核验的指纹不同，已停止交付。")
        return content, digest
    finally:
        os.close(descriptor)


def write_file(root, relative, content):
    components = parts(relative)
    parent = descend(root, components[:-1])
    try:
        descriptor = os.open(components[-1], os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=parent)
        try:
            remaining = memoryview(content)
            while remaining:
                remaining = remaining[os.write(descriptor, remaining):]
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
        os.fsync(parent)
    finally:
        os.close(parent)


def require_absent(root, relative):
    components = parts(relative)
    try:
        parent = descend(root, components[:-1])
    except FileNotFoundError:
        return
    try:
        try:
            os.stat(components[-1], dir_fd=parent, follow_symlinks=False)
        except FileNotFoundError:
            return
        raise TransferError("office_conflict", "输出目录已经存在；请选择新目录，原有文件不会被覆盖。")
    finally:
        os.close(parent)


def reserve_directory(root, relative):
    components = parts(relative)
    parent = descend(root, components[:-1], create=True)
    try:
        os.mkdir(components[-1], 0o700, dir_fd=parent)
        selected = os.open(components[-1], DIRECTORY, dir_fd=parent)
        os.fsync(parent)
        return selected
    finally:
        os.close(parent)


def verify_inputs(workspace, inputs):
    if not isinstance(inputs, list) or len(inputs) > 30:
        raise TransferError("office_receipt", "文档输入清单无效。")
    total = 0
    for item in inputs:
        if not isinstance(item, dict) or not re.fullmatch(r"[0-9a-f]{64}", item.get("sha256", "")):
            raise TransferError("office_receipt", "输入指纹无效。")
        content, _ = read_file(workspace, item.get("path"), item["sha256"])
        total += len(content)
        if len(content) != item.get("bytes") or total > MAX_TOTAL:
            raise TransferError("office_changed", "输入大小与已核验记录不同。")


def collect(workspace, transfer, request):
    names = request.get("inputs", [])
    if not isinstance(names, list) or len(names) > 30:
        raise TransferError("office_input", "一次最多处理 30 个输入文件。")
    if request.get("outputDir"):
        require_absent(workspace, request["outputDir"])
    result, total = [], 0
    for index, name in enumerate(names):
        extension = os.path.splitext(name)[1].lower()
        if extension not in (".docx", ".xlsx", ".pptx", ".pdf", ".md", ".png", ".jpg", ".jpeg"):
            raise TransferError("office_unsupported", "仅支持 DOCX/XLSX/PPTX/PDF/Markdown 和 PNG/JPEG 图片输入。")
        content, digest = read_file(workspace, name)
        total += len(content)
        if total > MAX_TOTAL:
            raise TransferError("office_limit", "输入文件总量超过 256 MiB。")
        mapped = f"inputs/{index}{extension}"
        write_file(transfer, mapped, content)
        result.append({"path": name, "mapped": mapped, "sha256": digest, "bytes": len(content)})
    verify_inputs(workspace, result)
    return {"ok": True, "inputs": result}


def publish(workspace, transfer, request):
    outputs = request.get("outputs")
    if not isinstance(outputs, list) or not outputs or len(outputs) > 200:
        raise TransferError("office_receipt", "文档工具输出清单无效。")
    verified, names, total = [], set(), 0
    for item in outputs:
        if not isinstance(item, dict) or len(parts(item.get("name"))) != 1 or item["name"] in names:
            raise TransferError("office_receipt", "文档输出路径无效或重复。")
        if not re.fullmatch(r"[0-9a-f]{64}", item.get("sha256", "")):
            raise TransferError("office_receipt", "文档输出指纹无效。")
        content, _ = read_file(transfer, "outputs/" + item["name"], item["sha256"])
        total += len(content)
        if len(content) != item.get("bytes") or total > MAX_TOTAL:
            raise TransferError("office_receipt", "文档输出大小与回执不一致或超过上限。")
        names.add(item["name"])
        verified.append((item, content))
    directory = descend(transfer, ["outputs"])
    try:
        if set(os.listdir(directory)) != names or request.get("primary") not in names:
            raise TransferError("office_receipt", "文档进程产生了未申报的输出或缺少主文档。")
    finally:
        os.close(directory)
    verify_inputs(workspace, request.get("inputs", []))
    destination = request.get("outputDir")
    selected = reserve_directory(workspace, destination)
    try:
        for item, content in verified:
            write_file(selected, item["name"], content)
        for item, _ in verified:
            read_file(workspace, destination + "/" + item["name"], item["sha256"])
        verify_inputs(workspace, request.get("inputs", []))
    except BaseException as error:
        if isinstance(error, TransferError):
            error.details = {"inspectOutputDir": destination}
        else:
            raise TransferError("office_scope", "交付路径在操作期间发生变化，请检查新建输出目录。", {"inspectOutputDir": destination}) from error
        raise
    finally:
        os.close(selected)
    return {"ok": True, "published": True}


def export_chunk(workspace, request):
    name, offset, limit = request.get("name"), request.get("offset"), request.get("limit")
    if len(parts(name)) != 1 or not isinstance(offset, int) or offset < 0 or not isinstance(limit, int) or not 0 < limit <= 8 * 1024 * 1024:
        raise TransferError("office_input", "文档归档分块请求无效。")
    parent = descend(workspace, ["outputs"])
    try:
        descriptor = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
    finally:
        os.close(parent)
    try:
        before = os.fstat(descriptor)
        if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or before.st_size > MAX_FILE or offset > before.st_size:
            raise TransferError("office_receipt", "文档归档来源不是允许的普通文件。")
        os.lseek(descriptor, offset, os.SEEK_SET)
        data, remaining = [], min(limit, before.st_size - offset)
        while remaining:
            chunk = os.read(descriptor, remaining)
            if not chunk:
                raise TransferError("office_changed", "文档归档来源发生变化。")
            data.append(chunk); remaining -= len(chunk)
        after = os.fstat(descriptor)
        if (after.st_nlink, after.st_size, after.st_mtime_ns, after.st_ctime_ns) != (1, before.st_size, before.st_mtime_ns, before.st_ctime_ns):
            raise TransferError("office_changed", "文档在归档过程中发生变化。")
        return {"ok": True, "offset": offset, "totalSize": before.st_size, "data": base64.b64encode(b"".join(data)).decode("ascii")}
    finally:
        os.close(descriptor)


def main():
    raw = sys.stdin.buffer.read(8 * 1024 * 1024 + 1)
    if len(raw) > 8 * 1024 * 1024:
        raise TransferError("office_limit", "文档搬运请求过大。")
    request = json.loads(raw)
    workspace = os.open("/workspace", DIRECTORY)
    if request.get("operation") == "export":
        try:
            return export_chunk(workspace, request)
        finally:
            os.close(workspace)
    transfer = os.open("/transfer", DIRECTORY)
    try:
        if request.get("operation") == "collect":
            return collect(workspace, transfer, request)
        if request.get("operation") == "verify":
            verify_inputs(workspace, request.get("inputs", []))
            return {"ok": True}
        if request.get("operation") == "publish":
            return publish(workspace, transfer, request)
        raise TransferError("office_input", "文档搬运操作无效。")
    finally:
        os.close(workspace)
        os.close(transfer)


if __name__ == "__main__":
    try:
        response = main()
    except TransferError as error:
        response = {"ok": False, "error": {"code": error.code, "message": str(error), "details": error.details}}
    except OSError as error:
        if error.errno == errno.EEXIST:
            code, message = "office_conflict", "输出目录已经存在；请选择新目录，原有文件不会被覆盖。"
        elif error.errno == errno.ENOENT:
            code, message = "office_input", "文档不存在或在处理期间被移动，请检查输入路径后重试。"
        else:
            code, message = "office_scope", "文档路径不安全或当前用户无权访问；符号链接和目录替换不会被跟随。"
        response = {"ok": False, "error": {"code": code, "message": message}}
    except Exception:
        response = {"ok": False, "error": {"code": "office_input", "message": "文档搬运请求无效。"}}
    print(json.dumps(response, ensure_ascii=False, separators=(",", ":")))
