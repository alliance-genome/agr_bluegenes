(ns bluegenes.components.ui.autocomplete
  "Text input with a suggestion list built from data the page already holds.
  Typing still filters the page; picking a suggestion runs that item's :on-pick."
  (:require [reagent.core :as r]
            [clojure.string :as str]
            [oops.core :refer [oget ocall]]
            [bluegenes.utils :refer [italicize-species]]))

(def ^:private max-suggestions 8)
(def ^:private min-chars 2)

(defn- matches
  "Items whose :label holds every word of `text`. Labels starting with `text` come first."
  [items text]
  (let [q (str/lower-case (str/trim text))
        words (str/split q #"\s+")
        label-of (comp str/lower-case :label)]
    (->> items
         (filter (fn [item] (every? #(str/includes? (label-of item) %) words)))
         (sort-by #(if (str/starts-with? (label-of %) q) 0 1))
         (take max-suggestions))))

(defn- species-span [s]
  (into [:span] (italicize-species s)))

(defn- highlight
  "Label hiccup with the first match of `text` in bold."
  [label text]
  (let [q (str/trim text)
        i (str/index-of (str/lower-case label) (str/lower-case q))]
    (if (nil? i)
      (species-span label)
      (let [j (+ i (count q))]
        [:span.label-text
         (species-span (subs label 0 i))
         [:mark (subs label i j)]
         (species-span (subs label j))]))))

(defn input
  "Props: :value, :on-change (called with the new text), :items (maps with
  :key, :label, :on-pick and an optional :meta), plus input attributes such as
  :id, :placeholder and :aria-label."
  [_props]
  (let [open? (r/atom false)
        active (r/atom -1)]
    (fn [{:keys [id value on-change items] :as props}]
      (let [text (or value "")
            shown (if (< (count (str/trim text)) min-chars) [] (matches items text))
            show? (boolean (and @open? (seq shown)))
            list-id (str id "-suggestions")
            pick! (fn [item]
                    (reset! open? false)
                    (reset! active -1)
                    ((:on-pick item)))]
        [:div.agr-autocomplete
         [:input.form-control
          (merge (dissoc props :value :on-change :items)
                 {:type "text"
                  :value text
                  :autoComplete "off"
                  :role "combobox"
                  :aria-autocomplete "list"
                  :aria-expanded show?
                  :aria-controls list-id
                  :aria-activedescendant (when (and show? (>= @active 0))
                                           (str list-id "-" @active))
                  :on-change (fn [e]
                               (reset! open? true)
                               (reset! active -1)
                               (on-change (oget e :target :value)))
                  :on-focus #(reset! open? true)
                  :on-blur #(reset! open? false)
                  :on-key-down (fn [e]
                                 (case (oget e :key)
                                   "ArrowDown" (when show?
                                                 (ocall e :preventDefault)
                                                 (swap! active #(min (inc %) (dec (count shown)))))
                                   "ArrowUp" (when show?
                                               (ocall e :preventDefault)
                                               (swap! active #(max (dec %) -1)))
                                   "Enter" (when (and show? (>= @active 0))
                                             (ocall e :preventDefault)
                                             (pick! (nth shown @active)))
                                   "Escape" (reset! open? false)
                                   nil))})]
         (when show?
           (into [:ul.agr-autocomplete-list {:id list-id :role "listbox"}]
                 (map-indexed
                  (fn [i item]
                    ^{:key (:key item)}
                    [:li {:id (str list-id "-" i)
                          :role "option"
                          :aria-selected (= i @active)
                          :class (when (= i @active) "active")
                          ;; mouse-down fires before the input's blur closes the list.
                          :on-mouse-down (fn [e]
                                           (ocall e :preventDefault)
                                           (pick! item))
                          :on-mouse-enter #(reset! active i)}
                     (highlight (:label item) text)
                     (when-let [meta-text (:meta item)]
                       [:span.meta meta-text])])
                  shown)))]))))
