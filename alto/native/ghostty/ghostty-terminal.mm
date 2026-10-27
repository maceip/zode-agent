#include <node_api.h>

#import <AppKit/AppKit.h>
#import <QuartzCore/CAMetalLayer.h>
#import <QuartzCore/CAShapeLayer.h>
#import <QuartzCore/CATransaction.h>

#include <atomic>
#include <memory>
#include <string>
#include <unordered_map>

#include "ghostty.h"

@interface CordisGhosttyView : NSView
@property(nonatomic, assign) ghostty_surface_t surface;
@property(nonatomic, copy) NSString* terminalId;
@property(nonatomic, strong) NSTrackingArea* terminalTrackingArea;
@property(nonatomic, assign) BOOL optionLeaderCandidate;
@property(nonatomic, assign) BOOL overlayActive;
@property(nonatomic, assign) NSRect overlayFrame;
@property(nonatomic, assign) CGFloat overlayRadius;
- (void)updateOverlayMask;
- (instancetype)initWithTerminalId:(NSString*)terminalId
                   workingDirectory:(NSString*)workingDirectory
                            command:(NSString*)command
                      configuration:(NSString*)configuration
                               frame:(NSRect)frame;
- (void)updateSurfaceSize;
@end

static NSView* host_view = nil;
static ghostty_app_t ghostty_app = nullptr;
static ghostty_config_t ghostty_config = nullptr;
static NSMutableDictionary<NSString*, CordisGhosttyView*>* terminal_views = nil;
static std::atomic_bool tick_pending = false;
static napi_threadsafe_function key_input_callback = nullptr;
static id key_event_monitor = nil;

struct CordisKeyInput {
  bool key_down;
  bool repeat;
  bool control;
  bool command;
  bool option;
  bool shift;
  std::string key;
  std::string code;
};

static void dispatch_key_input(
    napi_env env,
    napi_value callback,
    void*,
    void* raw_input) {
  std::unique_ptr<CordisKeyInput> input(static_cast<CordisKeyInput*>(raw_input));
  if (!env || !callback || !input) return;

  napi_value event;
  napi_create_object(env, &event);
  auto set_boolean = [&](const char* name, bool value) {
    napi_value part;
    napi_get_boolean(env, value, &part);
    napi_set_named_property(env, event, name, part);
  };
  auto set_string = [&](const char* name, const std::string& value) {
    napi_value part;
    napi_create_string_utf8(env, value.c_str(), value.size(), &part);
    napi_set_named_property(env, event, name, part);
  };
  set_string("type", input->key_down ? "keydown" : "keyup");
  set_string("key", input->key);
  set_string("code", input->code);
  set_boolean("ctrlKey", input->control);
  set_boolean("metaKey", input->command);
  set_boolean("altKey", input->option);
  set_boolean("shiftKey", input->shift);
  set_boolean("repeat", input->repeat);

  napi_value receiver;
  napi_get_undefined(env, &receiver);
  napi_call_function(env, receiver, callback, 1, &event, nullptr);
}

static void schedule_tick(void*) {
  if (tick_pending.exchange(true)) return;
  dispatch_async(dispatch_get_main_queue(), ^{
    tick_pending.store(false);
    if (ghostty_app) ghostty_app_tick(ghostty_app);
  });
}

static bool handle_action(ghostty_app_t, ghostty_target_s target, ghostty_action_s action) {
  if (action.tag != GHOSTTY_ACTION_RENDER || target.tag != GHOSTTY_TARGET_SURFACE) return false;
  ghostty_surface_t surface = target.target.surface;
  if ([NSThread isMainThread]) {
    ghostty_surface_draw(surface);
  } else {
    dispatch_async(dispatch_get_main_queue(), ^{ ghostty_surface_draw(surface); });
  }
  return true;
}

static CordisGhosttyView* view_from_userdata(void* userdata) {
  return (__bridge CordisGhosttyView*)userdata;
}

static bool read_clipboard(void* userdata, ghostty_clipboard_e, void* state) {
  CordisGhosttyView* view = view_from_userdata(userdata);
  NSString* value = [NSPasteboard.generalPasteboard stringForType:NSPasteboardTypeString] ?: @"";
  // Let Ghostty enforce paste protection and its clipboard-read policy. A
  // terminal process must never inherit user confirmation from this callback.
  ghostty_surface_complete_clipboard_request(view.surface, value.UTF8String, state, false);
  return true;
}

static void confirm_read_clipboard(
    void* userdata,
    const char*,
    void* state,
    ghostty_clipboard_request_e) {
  CordisGhosttyView* view = view_from_userdata(userdata);
  // Alto does not yet expose a native confirmation sheet. Complete the
  // request with no clipboard data instead of silently approving it.
  ghostty_surface_complete_clipboard_request(view.surface, "", state, true);
}

static void write_clipboard(
    void*,
    ghostty_clipboard_e,
    const ghostty_clipboard_content_s* content,
    size_t count,
    bool needs_confirmation) {
  // A false value means Ghostty's policy explicitly allows the write (and is
  // also used for user-driven copy actions). Requests that require a prompt
  // fail closed until Alto has a confirmation UI.
  if (needs_confirmation) return;
  for (size_t index = 0; index < count; index += 1) {
    if (!content[index].data) continue;
    NSString* value = [NSString stringWithUTF8String:content[index].data];
    if (!value) continue;
    [NSPasteboard.generalPasteboard clearContents];
    [NSPasteboard.generalPasteboard setString:value forType:NSPasteboardTypeString];
    return;
  }
}

static void close_surface(void* userdata, bool) {
  CordisGhosttyView* view = view_from_userdata(userdata);
  dispatch_async(dispatch_get_main_queue(), ^{ view.hidden = YES; });
}

static ghostty_input_mods_e event_modifiers(NSEventModifierFlags flags) {
  int mods = GHOSTTY_MODS_NONE;
  if (flags & NSEventModifierFlagShift) mods |= GHOSTTY_MODS_SHIFT;
  if (flags & NSEventModifierFlagControl) mods |= GHOSTTY_MODS_CTRL;
  if (flags & NSEventModifierFlagOption) mods |= GHOSTTY_MODS_ALT;
  if (flags & NSEventModifierFlagCommand) mods |= GHOSTTY_MODS_SUPER;
  if (flags & NSEventModifierFlagCapsLock) mods |= GHOSTTY_MODS_CAPS;
  return static_cast<ghostty_input_mods_e>(mods);
}

static void send_text(ghostty_surface_t surface, NSString* text) {
  if (!surface || text.length == 0) return;
  NSData* data = [text dataUsingEncoding:NSUTF8StringEncoding];
  if (data.length) {
    ghostty_surface_text(surface, static_cast<const char*>(data.bytes), data.length);
  }
}

static void apply_surface_configuration(
    ghostty_surface_t surface,
    NSString* terminal_id,
    NSString* configuration) {
  if (!surface || configuration.length == 0) return;

  NSString* filename = [NSString stringWithFormat:@"alto-ghostty-%@.conf", terminal_id];
  NSString* path = [NSTemporaryDirectory() stringByAppendingPathComponent:filename];
  NSError* write_error = nil;
  if (![configuration writeToFile:path
                       atomically:YES
                         encoding:NSUTF8StringEncoding
                            error:&write_error]) {
    NSLog(@"Could not write Ghostty surface configuration: %@", write_error);
    return;
  }

  ghostty_config_t surface_config = ghostty_config_new();
  if (surface_config) {
    ghostty_config_load_default_files(surface_config);
    ghostty_config_load_recursive_files(surface_config);
    ghostty_config_load_file(surface_config, path.fileSystemRepresentation);
    ghostty_config_load_recursive_files(surface_config);
    ghostty_config_finalize(surface_config);
    ghostty_surface_update_config(surface, surface_config);
    ghostty_config_free(surface_config);
  }
  [[NSFileManager defaultManager] removeItemAtPath:path error:nil];
}

static uint32_t unshifted_codepoint(NSEvent* event) {
  NSString* value = [event charactersByApplyingModifiers:0];
  if (value.length == 0) return 0;
  return [value characterAtIndex:0];
}

static NSString* key_text(NSEvent* event) {
  NSString* value = event.characters;
  if (value.length != 1) return value;
  unichar character = [value characterAtIndex:0];
  if (character < 0x20) {
    NSEventModifierFlags flags = event.modifierFlags & ~NSEventModifierFlagControl;
    return [event charactersByApplyingModifiers:flags];
  }
  if (character >= 0xF700 && character <= 0xF8FF) return nil;
  return value;
}

static NSString* browser_key(NSEvent* event) {
  switch (event.keyCode) {
    case 36: return @"Enter";
    case 48: return @"Tab";
    case 51: return @"Backspace";
    case 53: return @"Escape";
    case 123: return @"ArrowLeft";
    case 124: return @"ArrowRight";
    case 125: return @"ArrowDown";
    case 126: return @"ArrowUp";
    default: break;
  }
  NSString* value = event.charactersIgnoringModifiers;
  return value.length ? value.lowercaseString : @"Unidentified";
}

static NSString* browser_code(NSEvent* event, NSString* key) {
  switch (event.keyCode) {
    case 48: return @"Tab";
    case 123: return @"ArrowLeft";
    case 124: return @"ArrowRight";
    case 125: return @"ArrowDown";
    case 126: return @"ArrowUp";
    default: break;
  }
  if (key.length == 1) {
    unichar character = [key characterAtIndex:0];
    if ([[NSCharacterSet letterCharacterSet] characterIsMember:character]) {
      return [@"Key" stringByAppendingString:key.uppercaseString];
    }
    if ([[NSCharacterSet decimalDigitCharacterSet] characterIsMember:character]) {
      return [@"Digit" stringByAppendingString:key];
    }
  }
  return key;
}

static bool is_host_shortcut(NSEvent* event) {
  NSEventModifierFlags flags = event.modifierFlags;
  const bool command = (flags & NSEventModifierFlagCommand) != 0;
  const bool control = (flags & NSEventModifierFlagControl) != 0;
  const bool option = (flags & NSEventModifierFlagOption) != 0;
  const bool shift = (flags & NSEventModifierFlagShift) != 0;
  NSString* key = browser_key(event);
  NSString* lower = key.lowercaseString;

  if (command) {
    if ([lower isEqualToString:@"t"]
        || [lower isEqualToString:@"w"]
        || [lower isEqualToString:@"k"]
        || [lower isEqualToString:@"d"]
        || (shift && [lower isEqualToString:@"p"])) {
      return true;
    }
    if (lower.length == 1) {
      unichar character = [lower characterAtIndex:0];
      if (character >= '1' && character <= '9') return true;
    }
  }
  if (control && [key isEqualToString:@"Tab"]) return true;
  if (control && shift
      && ([key isEqualToString:@"ArrowLeft"] || [key isEqualToString:@"ArrowRight"])) {
    return true;
  }
  if (!option) return false;
  static NSSet<NSString*>* option_keys;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    option_keys = [NSSet setWithArray:@[
      @"n", @"h", @"j", @"k", @"l", @"i", @"o", @"=", @"-",
      @"ArrowLeft", @"ArrowRight", @"ArrowDown", @"ArrowUp",
    ]];
  });
  return [option_keys containsObject:key] || [option_keys containsObject:lower];
}

static void forward_browser_key(
    NSEvent* event,
    NSString* key,
    NSString* code,
    bool key_down,
    bool option_override) {
  if (!key_input_callback) return;
  auto input = std::make_unique<CordisKeyInput>();
  input->key_down = key_down;
  // AppKit aborts when isARepeat is queried on the FlagsChanged event used
  // for a bare Option tap. Modifier-only leader events can never repeat.
  input->repeat = event.type == NSEventTypeKeyDown && event.isARepeat;
  input->control = (event.modifierFlags & NSEventModifierFlagControl) != 0;
  input->command = (event.modifierFlags & NSEventModifierFlagCommand) != 0;
  input->option = option_override
      || (event.modifierFlags & NSEventModifierFlagOption) != 0;
  input->shift = (event.modifierFlags & NSEventModifierFlagShift) != 0;
  input->key = key.UTF8String ?: "Unidentified";
  const char* code_value = code.UTF8String;
  input->code = code_value ? code_value : input->key;
  CordisKeyInput* raw_input = input.release();
  if (napi_call_threadsafe_function(
          key_input_callback,
          raw_input,
          napi_tsfn_nonblocking) != napi_ok) {
    delete raw_input;
  }
}

static void forward_host_shortcut(NSEvent* event, bool key_down) {
  NSString* key = browser_key(event);
  forward_browser_key(event, key, browser_code(event, key), key_down, false);
}

static bool terminal_owns_first_responder() {
  NSResponder* responder = host_view.window.firstResponder;
  if (![responder isKindOfClass:[NSView class]]) return false;
  NSView* responder_view = (NSView*)responder;
  for (CordisGhosttyView* terminal in terminal_views.allValues) {
    if (responder_view == terminal || [responder_view isDescendantOf:terminal]) return true;
  }
  return false;
}

static void install_key_event_monitor() {
  if (key_event_monitor) return;
  key_event_monitor = [NSEvent
      addLocalMonitorForEventsMatchingMask:(NSEventMaskKeyDown | NSEventMaskKeyUp)
      handler:^NSEvent*(NSEvent* event) {
        if (!terminal_owns_first_responder() || !is_host_shortcut(event)) return event;
        forward_host_shortcut(event, event.type == NSEventTypeKeyDown);
        return nil;
      }];
}

static void remove_key_event_monitor() {
  if (!key_event_monitor) return;
  [NSEvent removeMonitor:key_event_monitor];
  key_event_monitor = nil;
}

static bool send_key_event(
    ghostty_surface_t surface,
    NSEvent* event,
    ghostty_input_action_e action) {
  if (!surface) return false;
  ghostty_input_key_s key = {};
  key.action = action;
  key.keycode = event.keyCode;
  key.mods = event_modifiers(event.modifierFlags);
  key.consumed_mods = event_modifiers(
      event.modifierFlags & ~(NSEventModifierFlagControl | NSEventModifierFlagCommand));
  key.unshifted_codepoint = unshifted_codepoint(event);
  NSString* text = action == GHOSTTY_ACTION_RELEASE ? nil : key_text(event);
  key.text = text.length ? text.UTF8String : nullptr;
  key.composing = false;
  return ghostty_surface_key(surface, key);
}

@implementation CordisGhosttyView

- (instancetype)initWithTerminalId:(NSString*)terminalId
                   workingDirectory:(NSString*)workingDirectory
                            command:(NSString*)command
                      configuration:(NSString*)configuration
                               frame:(NSRect)frame {
  self = [super initWithFrame:frame];
  if (!self) return nil;

  self.terminalId = terminalId;
  self.wantsLayer = YES;
  self.layerContentsRedrawPolicy = NSViewLayerContentsRedrawOnSetNeedsDisplay;
  self.layer.backgroundColor = [NSColor colorWithRed:242.0 / 255.0
                                                green:243.0 / 255.0
                                                 blue:246.0 / 255.0
                                                alpha:1.0].CGColor;

  ghostty_surface_config_s config = ghostty_surface_config_new();
  config.platform_tag = GHOSTTY_PLATFORM_MACOS;
  config.platform.macos.nsview = (__bridge void*)self;
  config.userdata = (__bridge void*)self;
  config.scale_factor = self.window.backingScaleFactor ?: NSScreen.mainScreen.backingScaleFactor;
  config.working_directory = workingDirectory.length ? workingDirectory.fileSystemRepresentation : nullptr;
  config.command = command.length ? command.UTF8String : nullptr;
  config.context = GHOSTTY_SURFACE_CONTEXT_SPLIT;
  self.surface = ghostty_surface_new(ghostty_app, &config);
  if (!self.surface) return nil;
  apply_surface_configuration(self.surface, terminalId, configuration);
  [self updateSurfaceSize];
  return self;
}

- (CALayer*)makeBackingLayer {
  return [CAMetalLayer layer];
}

- (BOOL)acceptsFirstResponder {
  return !self.overlayActive;
}

- (NSView*)hitTest:(NSPoint)point {
  // Modal web controls and their dismissing backdrop own all pointer input.
  return self.overlayActive ? nil : [super hitTest:point];
}

- (void)updateOverlayMask {
  [CATransaction begin];
  [CATransaction setDisableActions:YES];
  if (!self.overlayActive) {
    self.layer.mask = nil;
  } else {
    NSRect hostRect = self.overlayFrame;
    if (!host_view.isFlipped) hostRect.origin.y = host_view.bounds.size.height - NSMaxY(hostRect);
    NSRect cutout = [self convertRect:hostRect fromView:host_view];
    CGMutablePathRef path = CGPathCreateMutable();
    CGPathAddRect(path, nullptr, NSRectToCGRect(self.bounds));
    CGPathAddRoundedRect(path, nullptr, NSRectToCGRect(cutout), self.overlayRadius, self.overlayRadius);
    CAShapeLayer* mask = [CAShapeLayer layer];
    mask.frame = self.bounds;
    mask.fillRule = kCAFillRuleEvenOdd;
    mask.path = path;
    self.layer.mask = mask;
    CGPathRelease(path);
  }
  [CATransaction commit];
}

- (BOOL)acceptsFirstMouse:(NSEvent*)event {
  return YES;
}

- (BOOL)becomeFirstResponder {
  BOOL result = [super becomeFirstResponder];
  if (result && self.surface) ghostty_surface_set_focus(self.surface, true);
  return result;
}

- (BOOL)resignFirstResponder {
  self.optionLeaderCandidate = NO;
  BOOL result = [super resignFirstResponder];
  if (result && self.surface) ghostty_surface_set_focus(self.surface, false);
  return result;
}

- (void)setFrameSize:(NSSize)newSize {
  [super setFrameSize:newSize];
  [self updateSurfaceSize];
  [self updateOverlayMask];
}

- (void)viewDidChangeBackingProperties {
  [super viewDidChangeBackingProperties];
  [self updateSurfaceSize];
}

- (void)updateTrackingAreas {
  if (self.terminalTrackingArea) [self removeTrackingArea:self.terminalTrackingArea];
  self.terminalTrackingArea = [[NSTrackingArea alloc]
      initWithRect:NSZeroRect
           options:(NSTrackingMouseEnteredAndExited
                    | NSTrackingMouseMoved
                    | NSTrackingActiveInKeyWindow
                    | NSTrackingInVisibleRect)
             owner:self
          userInfo:nil];
  [self addTrackingArea:self.terminalTrackingArea];
  [super updateTrackingAreas];
}

- (void)updateSurfaceSize {
  if (!self.surface || self.bounds.size.width <= 0 || self.bounds.size.height <= 0) return;
  NSSize pixels = [self convertSizeToBacking:self.bounds.size];
  double scaleX = pixels.width / self.bounds.size.width;
  double scaleY = pixels.height / self.bounds.size.height;
  self.layer.contentsScale = self.window.backingScaleFactor ?: scaleX;
  ghostty_surface_set_content_scale(self.surface, scaleX, scaleY);
  ghostty_surface_set_size(
      self.surface,
      static_cast<uint32_t>(pixels.width),
      static_cast<uint32_t>(pixels.height));
  ghostty_surface_refresh(self.surface);
}

- (void)keyDown:(NSEvent*)event {
  // Option becomes the application leader only when tapped by itself. Any
  // accompanying key keeps its normal pane-navigation or terminal Meta role.
  self.optionLeaderCandidate = NO;
  const BOOL command = (event.modifierFlags & NSEventModifierFlagCommand) != 0;
  NSString* plain = event.charactersIgnoringModifiers.lowercaseString ?: @"";

  if (is_host_shortcut(event)) {
    forward_host_shortcut(event, true);
    return;
  }
  if (command && [plain isEqualToString:@"c"]) {
    ghostty_text_s selected = {};
    if (ghostty_surface_read_selection(self.surface, &selected)) {
      NSString* value = [[NSString alloc] initWithBytes:selected.text
                                                 length:selected.text_len
                                               encoding:NSUTF8StringEncoding];
      ghostty_surface_free_text(self.surface, &selected);
      if (value) {
        [NSPasteboard.generalPasteboard clearContents];
        [NSPasteboard.generalPasteboard setString:value forType:NSPasteboardTypeString];
      }
    }
    return;
  }
  if (command && [plain isEqualToString:@"v"]) {
    send_text(self.surface, [NSPasteboard.generalPasteboard stringForType:NSPasteboardTypeString]);
    return;
  }
  send_key_event(
      self.surface,
      event,
      event.isARepeat ? GHOSTTY_ACTION_REPEAT : GHOSTTY_ACTION_PRESS);
}

- (void)flagsChanged:(NSEvent*)event {
  const BOOL optionKey = event.keyCode == 58 || event.keyCode == 61;
  if (!optionKey) {
    self.optionLeaderCandidate = NO;
    [super flagsChanged:event];
    return;
  }

  const BOOL optionDown = (event.modifierFlags & NSEventModifierFlagOption) != 0;
  if (optionDown) {
    self.optionLeaderCandidate = YES;
    return;
  }
  if (!self.optionLeaderCandidate) return;

  self.optionLeaderCandidate = NO;
  NSString* code = event.keyCode == 61 ? @"AltRight" : @"AltLeft";
  // AppKit emits modifier changes instead of keyDown/keyUp for Option. Send a
  // complete tap only after release so Option-H/J/K/L never enters leader mode.
  forward_browser_key(event, @"Alt", code, true, true);
  forward_browser_key(event, @"Alt", code, false, false);
}

- (void)keyUp:(NSEvent*)event {
  if (is_host_shortcut(event)) {
    forward_host_shortcut(event, false);
    return;
  }
  send_key_event(self.surface, event, GHOSTTY_ACTION_RELEASE);
}

- (BOOL)performKeyEquivalent:(NSEvent*)event {
  if (event.type != NSEventTypeKeyDown) return NO;
  const BOOL command = (event.modifierFlags & NSEventModifierFlagCommand) != 0;
  const BOOL control = (event.modifierFlags & NSEventModifierFlagControl) != 0;
  NSString* plain = event.charactersIgnoringModifiers.lowercaseString ?: @"";
  const BOOL clipboard = command
      && ([plain isEqualToString:@"c"] || [plain isEqualToString:@"v"]);
  // AppKit treats control chords as key equivalents before keyDown reaches an
  // NSView. Keep them in the terminal responder path so shell editing keys
  // such as Ctrl-W, Ctrl-A, and Ctrl-R are encoded by Ghostty.
  if (!control && !clipboard && !is_host_shortcut(event)) {
    return [super performKeyEquivalent:event];
  }
  [self keyDown:event];
  return YES;
}

- (void)mouseDown:(NSEvent*)event {
  [self.window makeFirstResponder:self];
  NSPoint point = [self convertPoint:event.locationInWindow fromView:nil];
  ghostty_surface_mouse_pos(self.surface, point.x, self.bounds.size.height - point.y,
                            event_modifiers(event.modifierFlags));
  ghostty_surface_mouse_button(self.surface, GHOSTTY_MOUSE_PRESS, GHOSTTY_MOUSE_LEFT,
                               event_modifiers(event.modifierFlags));
}

- (void)mouseUp:(NSEvent*)event {
  ghostty_surface_mouse_button(self.surface, GHOSTTY_MOUSE_RELEASE, GHOSTTY_MOUSE_LEFT,
                               event_modifiers(event.modifierFlags));
}

- (void)rightMouseDown:(NSEvent*)event {
  [self.window makeFirstResponder:self];
  [self mouseMoved:event];
  ghostty_surface_mouse_button(self.surface, GHOSTTY_MOUSE_PRESS, GHOSTTY_MOUSE_RIGHT,
                               event_modifiers(event.modifierFlags));
}

- (void)rightMouseUp:(NSEvent*)event {
  ghostty_surface_mouse_button(self.surface, GHOSTTY_MOUSE_RELEASE, GHOSTTY_MOUSE_RIGHT,
                               event_modifiers(event.modifierFlags));
}

- (void)otherMouseDown:(NSEvent*)event {
  [self.window makeFirstResponder:self];
  [self mouseMoved:event];
  ghostty_surface_mouse_button(self.surface, GHOSTTY_MOUSE_PRESS, GHOSTTY_MOUSE_MIDDLE,
                               event_modifiers(event.modifierFlags));
}

- (void)otherMouseUp:(NSEvent*)event {
  ghostty_surface_mouse_button(self.surface, GHOSTTY_MOUSE_RELEASE, GHOSTTY_MOUSE_MIDDLE,
                               event_modifiers(event.modifierFlags));
}

- (void)mouseEntered:(NSEvent*)event {
  [self mouseMoved:event];
}

- (void)mouseExited:(NSEvent*)event {
  if (NSEvent.pressedMouseButtons != 0) return;
  ghostty_surface_mouse_pos(self.surface, -1, -1, event_modifiers(event.modifierFlags));
}

- (void)mouseMoved:(NSEvent*)event {
  NSPoint point = [self convertPoint:event.locationInWindow fromView:nil];
  ghostty_surface_mouse_pos(self.surface, point.x, self.bounds.size.height - point.y,
                            event_modifiers(event.modifierFlags));
}

- (void)mouseDragged:(NSEvent*)event {
  [self mouseMoved:event];
}

- (void)rightMouseDragged:(NSEvent*)event {
  [self mouseMoved:event];
}

- (void)otherMouseDragged:(NSEvent*)event {
  [self mouseMoved:event];
}

- (void)scrollWheel:(NSEvent*)event {
  double x = event.scrollingDeltaX;
  double y = event.scrollingDeltaY;
  int modifiers = 0;
  if (event.hasPreciseScrollingDeltas) {
    x *= 2;
    y *= 2;
    modifiers |= 1;
  }
  int momentum = GHOSTTY_MOUSE_MOMENTUM_NONE;
  switch (event.momentumPhase) {
    case NSEventPhaseBegan: momentum = GHOSTTY_MOUSE_MOMENTUM_BEGAN; break;
    case NSEventPhaseStationary: momentum = GHOSTTY_MOUSE_MOMENTUM_STATIONARY; break;
    case NSEventPhaseChanged: momentum = GHOSTTY_MOUSE_MOMENTUM_CHANGED; break;
    case NSEventPhaseEnded: momentum = GHOSTTY_MOUSE_MOMENTUM_ENDED; break;
    case NSEventPhaseCancelled: momentum = GHOSTTY_MOUSE_MOMENTUM_CANCELLED; break;
    case NSEventPhaseMayBegin: momentum = GHOSTTY_MOUSE_MOMENTUM_MAY_BEGIN; break;
    default: break;
  }
  modifiers |= momentum << 1;
  ghostty_surface_mouse_scroll(self.surface, x, y, modifiers);
}

- (void)dealloc {
  if (self.surface) {
    ghostty_surface_free(self.surface);
    self.surface = nullptr;
  }
}

@end

static void throw_error(napi_env env, const char* message) {
  napi_throw_error(env, nullptr, message);
}

static std::string string_argument(napi_env env, napi_value value) {
  size_t size = 0;
  napi_get_value_string_utf8(env, value, nullptr, 0, &size);
  std::string result(size, '\0');
  napi_get_value_string_utf8(env, value, result.data(), size + 1, &size);
  return result;
}

static napi_value undefined_value(napi_env env) {
  napi_value value;
  napi_get_undefined(env, &value);
  return value;
}

static void release_key_input_callback() {
  if (!key_input_callback) return;
  napi_release_threadsafe_function(key_input_callback, napi_tsfn_abort);
  key_input_callback = nullptr;
}

static void cleanup_ghostty(void*) {
  remove_key_event_monitor();
  for (CordisGhosttyView* view in terminal_views.allValues) {
    if (view.surface) {
      ghostty_surface_free(view.surface);
      view.surface = nullptr;
    }
    [view removeFromSuperview];
  }
  [terminal_views removeAllObjects];
  terminal_views = nil;
  if (ghostty_app) {
    ghostty_app_free(ghostty_app);
    ghostty_app = nullptr;
  }
  if (ghostty_config) {
    ghostty_config_free(ghostty_config);
    ghostty_config = nullptr;
  }
  release_key_input_callback();
  host_view = nil;
}

static CordisGhosttyView* find_view(napi_env env, napi_value value) {
  std::string id = string_argument(env, value);
  CordisGhosttyView* view = terminal_views[[NSString stringWithUTF8String:id.c_str()]];
  if (!view) throw_error(env, "native terminal does not exist");
  return view;
}

static napi_value initialize(napi_env env, napi_callback_info info) {
  if (ghostty_app && host_view) return undefined_value(env);
  size_t count = 3;
  napi_value args[3];
  napi_get_cb_info(env, info, &count, args, nullptr, nullptr);
  if (count < 3) {
    throw_error(env, "initialize requires a host view, resources directory, and key callback");
    return nullptr;
  }

  void* handle_data = nullptr;
  size_t handle_size = 0;
  napi_get_buffer_info(env, args[0], &handle_data, &handle_size);
  if (!handle_data || handle_size < sizeof(void*)) {
    throw_error(env, "Electron returned an invalid native window handle");
    return nullptr;
  }
  void* native_handle = *reinterpret_cast<void**>(handle_data);
  host_view = (__bridge NSView*)native_handle;
  std::string resources = string_argument(env, args[1]);
  setenv("GHOSTTY_RESOURCES_DIR", resources.c_str(), 1);

  napi_valuetype callback_type;
  napi_typeof(env, args[2], &callback_type);
  if (callback_type != napi_function) {
    throw_error(env, "initialize key callback must be a function");
    return nullptr;
  }
  napi_value callback_name;
  napi_create_string_utf8(env, "CordisGhosttyKeyInput", NAPI_AUTO_LENGTH, &callback_name);
  if (napi_create_threadsafe_function(
          env,
          args[2],
          nullptr,
          callback_name,
          0,
          1,
          nullptr,
          nullptr,
          nullptr,
          dispatch_key_input,
          &key_input_callback) != napi_ok) {
    throw_error(env, "could not create Ghostty key callback");
    return nullptr;
  }
  napi_unref_threadsafe_function(env, key_input_callback);

  char executable[] = "alto";
  char* argv[] = { executable, nullptr };
  if (ghostty_init(1, argv) != GHOSTTY_SUCCESS) {
    release_key_input_callback();
    host_view = nil;
    throw_error(env, "ghostty_init failed");
    return nullptr;
  }
  ghostty_config = ghostty_config_new();
  if (!ghostty_config) {
    release_key_input_callback();
    host_view = nil;
    throw_error(env, "ghostty_config_new failed");
    return nullptr;
  }
  ghostty_config_load_default_files(ghostty_config);
  ghostty_config_load_recursive_files(ghostty_config);
  ghostty_config_finalize(ghostty_config);

  ghostty_runtime_config_s runtime = {};
  runtime.wakeup_cb = schedule_tick;
  runtime.action_cb = handle_action;
  runtime.read_clipboard_cb = read_clipboard;
  runtime.confirm_read_clipboard_cb = confirm_read_clipboard;
  runtime.write_clipboard_cb = write_clipboard;
  runtime.close_surface_cb = close_surface;
  ghostty_app = ghostty_app_new(&runtime, ghostty_config);
  if (!ghostty_app) {
    ghostty_config_free(ghostty_config);
    ghostty_config = nullptr;
    release_key_input_callback();
    host_view = nil;
    throw_error(env, "ghostty_app_new failed");
    return nullptr;
  }
  ghostty_app_set_color_scheme(ghostty_app, GHOSTTY_COLOR_SCHEME_LIGHT);
  ghostty_app_set_focus(ghostty_app, true);
  terminal_views = [NSMutableDictionary dictionary];
  install_key_event_monitor();
  napi_add_env_cleanup_hook(env, cleanup_ghostty, nullptr);
  return undefined_value(env);
}

static napi_value create_terminal(napi_env env, napi_callback_info info) {
  size_t count = 2;
  napi_value args[2];
  napi_get_cb_info(env, info, &count, args, nullptr, nullptr);
  if (count < 2 || !ghostty_app || !host_view) {
    throw_error(env, "Ghostty native support is not initialized");
    return nullptr;
  }
  std::string id_value = string_argument(env, args[0]);
  NSString* identifier = [NSString stringWithUTF8String:id_value.c_str()];

  napi_value cwd_value;
  napi_value command_value;
  napi_value configuration_value;
  bool has_cwd = false;
  bool has_command = false;
  bool has_configuration = false;
  bool has_bounds = false;
  napi_has_named_property(env, args[1], "workingDirectory", &has_cwd);
  napi_has_named_property(env, args[1], "command", &has_command);
  napi_has_named_property(env, args[1], "configuration", &has_configuration);
  napi_has_named_property(env, args[1], "bounds", &has_bounds);
  NSString* cwd = @"";
  NSString* command = @"";
  NSString* configuration = @"";
  if (has_cwd) {
    napi_get_named_property(env, args[1], "workingDirectory", &cwd_value);
    std::string value = string_argument(env, cwd_value);
    cwd = [NSString stringWithUTF8String:value.c_str()];
  }
  if (has_command) {
    napi_get_named_property(env, args[1], "command", &command_value);
    std::string value = string_argument(env, command_value);
    command = [NSString stringWithUTF8String:value.c_str()];
  }
  if (has_configuration) {
    napi_get_named_property(env, args[1], "configuration", &configuration_value);
    std::string value = string_argument(env, configuration_value);
    configuration = [NSString stringWithUTF8String:value.c_str()];
  }

  NSRect frame = NSMakeRect(0, 0, 800, 600);
  if (has_bounds) {
    napi_value bounds_value;
    napi_get_named_property(env, args[1], "bounds", &bounds_value);
    double x = 0, y = 0, width = 0, height = 0;
    napi_value part;
    napi_get_named_property(env, bounds_value, "x", &part); napi_get_value_double(env, part, &x);
    napi_get_named_property(env, bounds_value, "y", &part); napi_get_value_double(env, part, &y);
    napi_get_named_property(env, bounds_value, "width", &part); napi_get_value_double(env, part, &width);
    napi_get_named_property(env, bounds_value, "height", &part); napi_get_value_double(env, part, &height);
    double native_y = host_view.isFlipped ? y : host_view.bounds.size.height - y - height;
    frame = NSMakeRect(x, native_y, width, height);
  }

  CordisGhosttyView* view = [[CordisGhosttyView alloc]
      initWithTerminalId:identifier
      workingDirectory:cwd
      command:command
      configuration:configuration
      frame:frame];
  if (!view) {
    throw_error(env, "ghostty_surface_new failed");
    return nullptr;
  }
  view.hidden = YES;
  terminal_views[identifier] = view;
  [host_view addSubview:view positioned:NSWindowAbove relativeTo:nil];
  return undefined_value(env);
}

static napi_value set_bounds(napi_env env, napi_callback_info info) {
  size_t count = 2;
  napi_value args[2];
  napi_get_cb_info(env, info, &count, args, nullptr, nullptr);
  CordisGhosttyView* view = find_view(env, args[0]);
  if (!view) return nullptr;

  double x = 0, y = 0, width = 0, height = 0;
  napi_value part;
  napi_get_named_property(env, args[1], "x", &part); napi_get_value_double(env, part, &x);
  napi_get_named_property(env, args[1], "y", &part); napi_get_value_double(env, part, &y);
  napi_get_named_property(env, args[1], "width", &part); napi_get_value_double(env, part, &width);
  napi_get_named_property(env, args[1], "height", &part); napi_get_value_double(env, part, &height);
  double native_y = host_view.isFlipped ? y : host_view.bounds.size.height - y - height;
  view.frame = NSMakeRect(x, native_y, width, height);
  [view updateOverlayMask];
  return undefined_value(env);
}

static napi_value set_visible(napi_env env, napi_callback_info info) {
  size_t count = 2;
  napi_value args[2];
  napi_get_cb_info(env, info, &count, args, nullptr, nullptr);
  CordisGhosttyView* view = find_view(env, args[0]);
  if (!view) return nullptr;
  bool visible = false;
  napi_get_value_bool(env, args[1], &visible);
  view.hidden = !visible;
  if (view.surface) ghostty_surface_set_occlusion(view.surface, visible);
  return undefined_value(env);
}

static napi_value set_overlay(napi_env env, napi_callback_info info) {
  size_t count = 2;
  napi_value args[2];
  napi_get_cb_info(env, info, &count, args, nullptr, nullptr);
  CordisGhosttyView* view = find_view(env, args[0]);
  if (!view || count < 2) return nullptr;
  napi_value null_value;
  napi_get_null(env, &null_value);
  bool clear = false;
  napi_strict_equals(env, args[1], null_value, &clear);
  view.overlayActive = !clear;
  if (!clear) {
    double x = 0, y = 0, width = 0, height = 0, radius = 0;
    napi_value part;
    napi_get_named_property(env, args[1], "x", &part); napi_get_value_double(env, part, &x);
    napi_get_named_property(env, args[1], "y", &part); napi_get_value_double(env, part, &y);
    napi_get_named_property(env, args[1], "width", &part); napi_get_value_double(env, part, &width);
    napi_get_named_property(env, args[1], "height", &part); napi_get_value_double(env, part, &height);
    napi_get_named_property(env, args[1], "borderRadius", &part); napi_get_value_double(env, part, &radius);
    // Retain viewport coordinates so a host-window resize cannot stale the mask.
    view.overlayFrame = NSMakeRect(x, y, width, height);
    view.overlayRadius = radius;
    if (view.window.firstResponder == view) [view.window makeFirstResponder:nil];
  }
  [view updateOverlayMask];
  if (view.surface) ghostty_surface_refresh(view.surface);
  return undefined_value(env);
}

static napi_value focus_terminal(napi_env env, napi_callback_info info) {
  size_t count = 1;
  napi_value args[1];
  napi_get_cb_info(env, info, &count, args, nullptr, nullptr);
  CordisGhosttyView* view = find_view(env, args[0]);
  if (view && !view.overlayActive) [view.window makeFirstResponder:view];
  return undefined_value(env);
}

static napi_value configure_terminal(napi_env env, napi_callback_info info) {
  size_t count = 2;
  napi_value args[2];
  napi_get_cb_info(env, info, &count, args, nullptr, nullptr);
  CordisGhosttyView* view = find_view(env, args[0]);
  if (!view) return nullptr;
  std::string configuration_value = string_argument(env, args[1]);
  NSString* configuration = [NSString stringWithUTF8String:configuration_value.c_str()];
  apply_surface_configuration(view.surface, view.terminalId, configuration);
  return undefined_value(env);
}

static napi_value destroy_terminal(napi_env env, napi_callback_info info) {
  size_t count = 1;
  napi_value args[1];
  napi_get_cb_info(env, info, &count, args, nullptr, nullptr);
  std::string id_value = string_argument(env, args[0]);
  NSString* identifier = [NSString stringWithUTF8String:id_value.c_str()];
  CordisGhosttyView* view = terminal_views[identifier];
  if (view) {
    if (view.surface) {
      ghostty_surface_free(view.surface);
      view.surface = nullptr;
    }
    [view removeFromSuperview];
    [terminal_views removeObjectForKey:identifier];
  }
  return undefined_value(env);
}

static napi_value destroy_all(napi_env env, napi_callback_info) {
  for (CordisGhosttyView* view in terminal_views.allValues) {
    if (view.surface) {
      ghostty_surface_free(view.surface);
      view.surface = nullptr;
    }
    [view removeFromSuperview];
  }
  [terminal_views removeAllObjects];
  return undefined_value(env);
}

static napi_value module_init(napi_env env, napi_value exports) {
  const napi_property_descriptor properties[] = {
    { "initialize", nullptr, initialize, nullptr, nullptr, nullptr, napi_default, nullptr },
    { "create", nullptr, create_terminal, nullptr, nullptr, nullptr, napi_default, nullptr },
    { "setBounds", nullptr, set_bounds, nullptr, nullptr, nullptr, napi_default, nullptr },
    { "setVisible", nullptr, set_visible, nullptr, nullptr, nullptr, napi_default, nullptr },
    { "setOverlay", nullptr, set_overlay, nullptr, nullptr, nullptr, napi_default, nullptr },
    { "focus", nullptr, focus_terminal, nullptr, nullptr, nullptr, napi_default, nullptr },
    { "configure", nullptr, configure_terminal, nullptr, nullptr, nullptr, napi_default, nullptr },
    { "destroy", nullptr, destroy_terminal, nullptr, nullptr, nullptr, napi_default, nullptr },
    { "destroyAll", nullptr, destroy_all, nullptr, nullptr, nullptr, napi_default, nullptr },
  };
  napi_define_properties(env, exports, sizeof(properties) / sizeof(properties[0]), properties);
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, module_init)
