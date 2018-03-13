(function() {
  // Stars a profiler event, returns callback for ending the event
  var start = () => {
    var event = [[]];

    var parent = events[events.length - 1];
    parent[0].push(event);

    events.push(event);
    var start = performance.now();

    return (name, details) => {
      var end = performance.now();
      events.pop();

      event.push(start, end, name, details);
    }
  }

  // Replaces a function with a probe that calls original while collecting timing
  function probe(owner, property, name, details) {
    var original = owner[property];
    if (!original) {
      console.log("Probing unexisting method", owner, property);
      debugger;
    }
    owner[property] = function profilerProbe() {
      var d = details;
      if (d === undefined) {
        d = this;
      } else if (details && details.apply) {
        d = details.apply(this, arguments);
      }

      var n = (name && name.apply) ? name.apply(this, arguments) : name;

      var stop = start();
      var result = original.apply(this, arguments);
      stop(n, d);
      return result;
    }
  }

  // Creates an asynchronous probe function that emits a profiler event based on the profiler status when the probe was created
  function createAsnycProbe(callback, name) {
    if (callback == null) {
      return null;
    }
    if (events.length == 1) {
      return callback;
    }
    var parent = events[events.length - 1];
    return function asyncProfilerProbe() {
      if (!parent[3]) {
        return callback.apply(this, arguments);
      } else {
        var end = start();
        var result = callback.apply(this, arguments);
        end(name + " from " + parent[3], parent[4]);
        return result;
      }
    }
  }

  // Replaces a function with a probe that replaces specific arguments with async probes
  function probeAsync(owner, property, name, callbackArgumentIndexes) {
    var old = owner[property];
    if (!old) {
      console.log("Probing unexisting method", owner, property);
      debugger;
    }

    if (typeof callbackArgumentIndexes == "number") {
      callbackArgumentIndexes = [callbackArgumentIndexes];
    }

    owner[property] = function asyncProbeInjector() {
      var callbacks = Object.create(null);
      var hasCallbacks = false;

      for (var i = 0; i < callbackArgumentIndexes.length; i++) {
        var index = callbackArgumentIndexes[i];
        var callback = arguments[index];
        var newCallback = createAsnycProbe(callback, name);
        if (callback != newCallback) {
          callbacks[index] = newCallback;
          hasCallbacks = true;
        }
      }

      if (!hasCallbacks) {
        return old.apply(this, arguments);
      }

      // Copy arguments to keep JIT happy
      var args = Array(arguments.length);
      for (var i = 0; i < arguments.length; i++) {
        args[i] = callbacks[i] || arguments[i];
      }

      return old.apply(this, args);
    }
  }

  // Event caption generator for custom element instances
  function tagNameAppender(postfix) {
    return function() {
      return this.tagName.toLowerCase() + postfix;
    }
  }

  // Event caption generator for Polymer.Element subclasses
  function isNameAppender(postfix) {
    return function() {
      return this.is + postfix;
    }
  }

  // Collects callback names for a specific effect type
  function collectcEffectMethods(effectMethods, instance, effectName) {
    var properties = instance[effectName];
    if (!properties) {
      return;
    }
    var keys = Object.keys(properties);
    for (var i = 0; i < keys.length; i++) {
      var effects = properties[keys[i]];
      for (var j = 0; j < effects.length; j++) {
        var info = effects[j].info;
        if (info && info.methodName) {
          effectMethods.add(info.methodName);
        } else if (info && info.method) {
          effectMethods.add(info.method);
        }
      }
    }
  }

  // Probes "value" callbacks all properties of a Polymer.Element
  function probeDefaults(type) {
    var props = type._properties;
    for (var p in props) {
      var info = props[p];
      if (info && typeof info.value == "function") {
        probe(info, "value", tagNameAppender("." + p + ".value()"));
      }
    }
  }

  // Probes various interesting points on the prototype of a (Polymer) custom element
  function probeCustomElementType(name, type) {
    if (type.prototype.ready) {
      probe(type.prototype, "ready", name + ".ready()");
    }
    if (type.prototype._bindTemplate) {
      probe(type.prototype, "_bindTemplate", name + "._bindTemplate()");
    }
    if (type.prototype.attributeChangedCallback) {
      probe(type.prototype, "attributeChangedCallback", attr => name + ".attributeChangedCallback(" + attr + ")");
    }

    // Probe Polymer data binding methods once they have been identified
    var originalInintProps = type.prototype._initializeProperties;
    type.prototype._initializeProperties = function _initializePropertiesProbe() {
      if (!type.defaultsProbed) {
        probeDefaults(type);
        type.defaultProbed;
      }
      originalInintProps.apply(this, arguments);

      if (this.__effectsProbed) {
        return;
      }
      effectMethods = new Set();
      collectcEffectMethods(effectMethods, this, "__computeEffects");
      collectcEffectMethods(effectMethods, this, "__reflectEffects");
      collectcEffectMethods(effectMethods, this, "__notifyEffects");
      collectcEffectMethods(effectMethods, this, "__propagateEffects");
      collectcEffectMethods(effectMethods, this, "__observeEffects");

      effectMethods.forEach(effectMethod => {
        probe(this, effectMethod, name + "." + effectMethod);
      });

      this.__effectsProbed = true;
    }
  }

  // Probe specific methods of some of Polymer's built-in elements
  var customElementProbes = {
    "dom-bind": function(type) {
      probe(type.prototype, "__insertChildren", "DomBind.__insertChildren()");
      probe(type.prototype, "render", "DomBind.render()");
    },
    "dom-repeat": function(type) {
      probe(type.prototype, "__render", "DomRepeat.__render()");
    }
  }

  // Add async probes with a custom name for all DOM event listeners
  var oldAddEventListener = HTMLElement.prototype.addEventListener;
  HTMLElement.prototype.addEventListener = function addEventListenerProbe(name, callback) {
    var newCallback = createAsnycProbe(callback, "on-" + name);

    if (newCallback == callback) {
      return oldAddEventListener.apply(this, arguments);
    } else {
      // Copy arguments to keep JIT happy
      var args = Array(arguments.length);
      for (var i = 0; i < arguments.length; i++) {
        args[i] = (i == 1) ? newCallback : arguments[i];
      }

      callback.__profilerOriginalCallback = newCallback;

      return oldAddEventListener.apply(this, args);
    }
  }

  var oldRemoveEventListener = HTMLElement.prototype.removeEventListener
  HTMLElement.prototype.removeEventListener = function removeEventListenerIntercept(name, callback) {
    if (!callback.__profilerOriginalCallback) {
      return oldRemoveEventListener.apply(this, arguments);
    }

    // Copy arguments to keep JIT happy
    var args = Array(arguments.length);
    for (var i = 0; i < arguments.length; i++) {
      args[i] = (i == 1) ? callback.__profilerOriginalCallback : arguments[i];
    }

    return oldRemoveEventListener.apply(this, args);
  }

  // Probe some standard async handlers
  probeAsync(window, "setTimeout", "setTimeout", 0);
  probeAsync(Promise.prototype, "then", "Promise.then", [0, 1]);
  //probeAsync(window, "requestAnimationFrame", "requestAnimationFrame", 0);

  // Probes various interesting core Polymer functions
  function probePolymerTypes() {
    probe(Polymer.Element.prototype, "ready", tagNameAppender(".PolymerElement.ready()"));
    probe(Polymer.Element.prototype, "_stampTemplate", tagNameAppender("._stampTemplate()"));
    probe(Polymer.Element.prototype, "_attachDom", tagNameAppender("._attachDom()"));
    probe(Polymer.Element.prototype, "_initializeProperties", tagNameAppender("._initializeProperties()"));
    probe(Polymer.Element.prototype, "_setProperty", function(property) {
      return "set " + this.tagName.toLowerCase() + "." + property;
    });

    probe(Polymer.TemplateInstanceBase.prototype, "_stampTemplate", "TemplateInstanceBase._stampTemplate", null);

    probe(Polymer.Element, "createProperties", isNameAppender(".createProperties()"), null);
    probe(Polymer.Element, "_parseTemplateContent", isNameAppender("._parseTemplateContent()"), null);
    probe(Polymer.Element, "_finalizeTemplate", isNameAppender("._finalizeTemplate()"), null);

    probe(Polymer.StyleGather, "stylesFromTemplate", "Polymer.StyleGather.stylesFromTemplate()", null);

    probeAsync(Polymer.RenderStatus, "afterNextRender", "afterNextRender", 1);
    probeAsync(Polymer.RenderStatus, "beforeNextRender", "beforeNextRender", 1);
    probeAsync(Polymer.Debouncer, "debounce", "debounce", 2);

    probeAsync(Polymer.Async.idlePeriod, "run", "Async.idlePeriod", 0);
    probeAsync(Polymer.Async.microTask, "run", "Async.microTask", 0);
    probeAsync(Polymer.Async.timeOut, "run", "Async.timeOut", 0);
    //probeAsync(Polymer.Async.animationFrame, "run", "Async.animationFrame", 0);

    class FlattenedNodesObserverProbe extends Polymer.FlattenedNodesObserver {
      constructor(target, callback) {
        var newCallback = createAsnycProbe(callback, "FlattenedNodesObserver");
        super(target, newCallback);
      }
    }
    Polymer.FlattenedNodesObserver = FlattenedNodesObserverProbe;
  }

  // Override customElements.define to add various probes for custom elements
  var originalDefine = window.customElements.define;
  window.customElements.define = function defineProbe(name, type) {
    // Inject probing into polymer once we detect that it has been loaded
    if (Polymer.Element && probePolymerTypes) {
      probePolymerTypes();
      probePolymerTypes = null;
    }

    probeCustomElementType(name, type);

    if (customElementProbes[name]) {
      customElementProbes[name].call(null, type);
    }

    // Probe the custom element type to collect various information
    var typeToRegister = type;
    // No idea why, but it won't work with that type
    if (type.is != "vaadin-grid-templatizer") {
      typeToRegister = class CustomElementProbe extends type {
        constructor() {
          var end = start();
          super();
          end(name + ".constructor()", this);
        }

        static get observedAttributes() {
          var end = start();
          var value = super.observedAttributes;
          end(name + ".observedAttributes", null);
          return value;
        }
      }
    }

    // Run original define method
    var end = start();
    originalDefine.apply(window.customElements, [name, typeToRegister]);
    end("customElements.define", name);
  }

  if (window.ShadyCSS) {
    probe(window.ShadyCSS, "prepareTemplate", "ShadyCSS.prepareTemplate()", null);
    probe(window.ShadyCSS, "styleElement", "ShadyCSS.styleElement()", (element) => element);
  }

  // Lots of bookeeing to be able to throttle logging for "some" browsers
  var consoleQueue = [];
  var specialConsole = (navigator.userAgent.indexOf("Trident") > 0 || navigator.userAgent.indexOf("Edge") > 0);

  function flushConsole() {
    if (specialConsole) {
      consoleQueue.unshift(["log", ["Going to log " + consoleQueue.length + " messages, this might take a while"]]);
      // Ensure we log less than 1000 lines per second
      function logAsync() {
        if (flushConsoleMessages(900)) {
          setTimeout(logAsync, 1100);
        }
      }
      logAsync();
    } else {
      while (flushConsoleMessages(1000));
    }
  }

  // Combine all console.log arguments into one string
  function combineArgs(args) {
    var result = "";

    for (var i = 0; i < args.length; i++) {
      if (result.length != 0) {
        result += " ";
      }
      var arg = args[i];
      if (arg instanceof HTMLElement) {
        try {
          var html = arg.outerHTML;
          arg = html.substring(0, html.indexOf(">") + 1);
        } catch (ignore)  {
          arg = "* unknown element *";
        }
      }

      result += arg;
    }

    return result;
  }

  function flushConsoleMessages(count) {
    for (var i = 0; i < count; i++) {
      if (!consoleQueue.length) {
        return false;
      }
      var cmd = consoleQueue.shift();
      var name = cmd[0];
      var args = cmd[1];

      // Edge messes things up when mixing "log" and "group"-related messages
      if (specialConsole && name == "log") {
        name = "groupCollapsed";
        consoleQueue.unshift(["groupEnd"]);
      }

      // Combine args for browsers that don't handle multiple parameters in group and groupCollapsed
      if (specialConsole && args && args.length >= 2) {
        var arg = combineArgs(args);
        args = [arg];
      }

      console[name].apply(console, args);
    }
    return true;
  }

  // Init the events array
  clearEvents();

  // Extract duration from an event
  function getDuration(event) {
    var duration = +event[2] - +event[1];
    return isNaN(duration) ? 0 : duration;
  }

  // Inject "* own time *" events in significant gaps between tracked events
  function injectOwnTimes(children, parent) {
    var duration = getDuration(parent);
    var expandedChildren = [];

    var previousEnd = parent[1];

    function ownTimeIfSignificant(nextStart) {
      var length = nextStart - previousEnd;
      if (length > duration * 0.1 || length > 10) {
        expandedChildren.push([[], previousEnd, nextStart, parent[3] == "ROOT" ? "* unaccounted * " : "* own time *"]);
      }
    }

    for (var i = 0; i < children.length; i++) {
      var child = children[i];

      ownTimeIfSignificant(child[1]);

      expandedChildren.push(child);
      previousEnd = child[2];
    }

    ownTimeIfSignificant(parent[2]);

    return expandedChildren;
  }

  // Combine (relatively) small events into a  "* n short events * " sub event
  function groupSmallItems(children) {
    var groupedChildren = [];
    var duration = children[children.length - 1][2] - children[0][1];
    var groupThreshold = Math.min(duration / 10, 5);

    var group = [];

    function closeGroup() {
      if (group.length) {
        var groupEntry;
        if (group.length > 2) {
          var groupEntry = [group, group[0][1], group[group.length - 1][2], "* " + group.length + " short events *"];
          groupEntry.group = true;
          groupedChildren.push(groupEntry);
        } else {
          Array.prototype.push.apply(groupedChildren, group);
        }

        group = [];
      }
    }

    for (var i = 0; i < children.length; i++) {
      var child = children[i];
      if (getDuration(child) < groupThreshold) {
        group.push(child);
      } else {
        closeGroup();
        groupedChildren.push(child);
      }
    }
    closeGroup();

    // Undo grouping if everything is one big group
    if (groupedChildren.length == 1 && groupedChildren[0].group) {
      return groupedChildren[0][0];
    } else {
      return groupedChildren;
    }
  }

  function leftPad(value, length) {
    var padded = '' + value;
    while (padded.length < length) {
      padded = " " + padded;
    }
    return padded;
  }

  function formatDuration(duration) {
    var fixed = duration.toFixed(1);
    return leftPad(fixed, 8);
  }

  // Recursive function for logging one events and its children
  function logEvent(event, expanded) {
    var name = event[3];
    var children = event[0];

    var duration = getDuration(event);
    var childDuration = 0;
    for (var i = 0; i < children.length; i++) {
      childDuration += getDuration(children[i]);
    }
    var ownDuration = duration - childDuration;

    var status = [formatDuration(duration) + " " + formatDuration(ownDuration) + "  " + name];
    if (event[4]) {
      status.push(event[4]);
    }

    var processed = 1;

    if (children.length) {
      var expandedChildren = injectOwnTimes(children, event);
      expandedChildren = groupSmallItems(expandedChildren);

      var group = expanded ? "group" : "groupCollapsed";
      consoleQueue.push([group, status]);

      for (var i = 0; i < expandedChildren.length; i++) {
        var child = expandedChildren[i];

        var childDuration = getDuration(child);

        var expandChild = childDuration > duration * 0.75;
        processed += logEvent(child, expandChild);
      }

      consoleQueue.push(["groupEnd"]);
    } else {
      consoleQueue.push(["log", status]);
    }

    return processed;
  }

  // Resets the events array
  function clearEvents() {
    events = [[[],0,0,"ROOT"]];
  }

  // Inject current top-level timing into the ROOT event
  function updateRoot() {
    var rootEvent = events[0];
    var rootChildren = rootEvent[0];

    var firstChildStart = rootChildren[0][1];
    var lastChildEnd = rootChildren[rootChildren.length - 1][2];

    rootEvent[1] = firstChildStart;
    rootEvent[2] = lastChildEnd;
  }

  // Recursively summarize data for an event
  function collectSummaries(summaries, event) {
    var duration = getDuration(event);
    var childDuration = 0;

    var children = event[0];
    for (var i = 0; i < children.length; i++) {
      var child = children[i];
      childDuration += getDuration(child);

      collectSummaries(summaries, child);
    }

    var ownDuration = duration - childDuration;
    var name = event[3];
    var summary = summaries[name] || [0, 0, 0];
    summary[0] += ownDuration;
    summary[1] += duration;
    summary[2] += 1;

    summaries[name] = summary;
  }

  // Print summaries sorted by a specific summary collection
  function printSummaries(caption, summaries, valueIndex) {
    var names = Object.keys(summaries);
    names.sort((a, b) => summaries[b][valueIndex] - summaries[a][valueIndex]);

    consoleQueue.push(["groupCollapsed", [caption]]);
    var groupCount = 1;

    for (var i = 0; i < names.length; i++) {
      var name = names[i];
      if (i != 0 && i % 20 == 0) {
        groupCount++;
        consoleQueue.push(["groupCollapsed", ["Items " + i + " - " + (i + 19)]])
      }

      var summary = summaries[name];
      var message = "own time: " + formatDuration(summary[0]) +
        " | total time: " + formatDuration(summary[1]) +
        " | count: " + leftPad(summary[2], 6) +
        " | " + name;
      consoleQueue.push(["log", [message]]);
    }
    for (var i = 0; i < groupCount; i++) {
      consoleQueue.push(["groupEnd"]);
    }
  }

  // Export public API
  window.profiler = {
    showSummaries: function() {
      updateRoot();

      var summaries = Object.create(null);
      collectSummaries(summaries, events[0]);
      delete summaries["ROOT"];

      printSummaries("Top by own time", summaries, 0);
      printSummaries("Top by total time", summaries, 1);
      printSummaries("Top by count", summaries, 2);
      consoleQueue.push(["log", ["Processed " + Object.keys(summaries).length + " event types"]]);

      flushConsole();
    },
    showTimeline: function() {
      updateRoot();

      var count = logEvent(events[0], true);
      consoleQueue.push(["log", ["Processed " + count + " events"]]);

      flushConsole();
    },
    clearEvents: clearEvents,
  };

})();
